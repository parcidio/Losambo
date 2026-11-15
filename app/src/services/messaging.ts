import { downloadFile } from '../net.js';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { ApiError } from '../http.js';
import { otpCode, sha256, shortId } from '../security.js';
import { chatIdFor, messageId, phoneDigits, WahaError, type WahaClient } from '../waha.js';
import { emit } from './webhooks.js';
import { clientFor, getNumber, listNumbers, usable, type NumberRow, type TenantNumber } from './numbers.js';
import { pacedSend, sentLastMinute } from './pacing.js';
import { assertCanSendMessage, assertSubscriptionActive, getTenant, subscriptionActive } from './tenants.js';

export const REVERSE_PREFIX = 'LSB-';

/** Escolhe o número indicado, ou o número ligado com mais folga. */
export async function pickNumber(tenantId: number, via?: string | null, allowed?: number[] | null): Promise<TenantNumber> {
  const tenant = await assertSubscriptionActive(tenantId);
  if (via) {
    const n = await getNumber(tenantId, via);
    if (!usable(tenant, n)) {
      throw new ApiError(402, 'own_numbers_not_in_plan', 'Números próprios só estão disponíveis no plano Negócio.');
    }
    if (allowed && !allowed.includes(n.id)) throw new ApiError(403, 'number_not_allowed', 'Esta chave não pode usar este número.');
    if (n.status !== 'WORKING') throw new ApiError(409, 'number_not_working', `O número ${n.session_name} está ${n.status}.`);
    return n;
  }
  const rank: Record<string, number> = { NONE: 0, FIRST_WARNING: 1, SECOND_WARNING: 2, CAPPED: 9 };
  const candidates = (await listNumbers(tenantId))
    .filter((n) => n.status === 'WORKING' && usable(tenant, n))
    .filter((n) => !allowed || allowed.includes(n.id))
    .sort(
      (a, b) =>
        (rank[a.capping_status ?? 'NONE'] ?? 0) - (rank[b.capping_status ?? 'NONE'] ?? 0) ||
        sentLastMinute(a.id) / a.max_per_minute - sentLastMinute(b.id) / b.max_per_minute,
    );
  if (!candidates.length) {
    throw new ApiError(409, 'number_not_working', 'Nenhum número disponível nesta conta (estado WORKING). Fale com a Losambo para lhe atribuir um número.');
  }
  return candidates[0];
}

async function ensureOnWhatsApp(waha: WahaClient, n: NumberRow, phone: string): Promise<string> {
  const r = await waha.checkExists(n.session_name, phoneDigits(phone));
  if (!r.numberExists) throw new ApiError(404, 'not_on_whatsapp', 'O destinatário não tem WhatsApp.');
  return r.chatId ?? chatIdFor(phone);
}

async function recordOut(tenantId: number, n: NumberRow, chatId: string, kind: string, body: string | null, res: unknown): Promise<string | null> {
  const id = messageId(res as any);
  await query(
    `INSERT INTO messages (tenant_id, number_id, direction, chat_id, kind, body, waha_id, ack) VALUES ($1,$2,'out',$3,$4,$5,$6,'sent')`,
    [tenantId, n.id, chatId, kind, body, id],
  );
  await query('UPDATE numbers SET last_activity = now() WHERE id = $1', [n.id]);
  return id;
}

export interface SendMessageInput {
  to: string;
  via?: string | null;
  type: 'text' | 'image' | 'file';
  text?: string;
  file?: { url: string; mimetype?: string; filename?: string };
  caption?: string;
}

export async function sendMessage(tenantId: number, input: SendMessageInput, allowed?: number[] | null) {
  await assertCanSendMessage(await getTenant(tenantId));
  const n = await pickNumber(tenantId, input.via, allowed);
  const waha = await clientFor(n);
  const chatId = await ensureOnWhatsApp(waha, n, input.to);
  const text = input.type === 'text' ? input.text ?? '' : input.caption ?? null;
  // O ficheiro é descarregado pela Losambo (com proteção SSRF) e entregue ao WAHA em base64:
  // o WAHA, dentro da rede interna, nunca vai buscar URLs indicados pelo cliente.
  const file =
    input.type === 'text' || !input.file
      ? null
      : await downloadFile(input.file.url).then((f) => ({
          ...f,
          mimetype: input.file!.mimetype ?? f.mimetype,
          filename: input.file!.filename ?? f.filename,
        }));
  const res = await pacedSend(n, waha, chatId, text, () => {
    if (input.type === 'image') return waha.sendImage(n.session_name, chatId, file!, input.caption);
    if (input.type === 'file') return waha.sendFile(n.session_name, chatId, file!, input.caption);
    return waha.sendText(n.session_name, chatId, input.text ?? '');
  });
  const id = await recordOut(tenantId, n, chatId, input.type, text, res);
  return { id, status: 'sent', via: n.session_name, chatId };
}

function otpText(app: string | null | undefined, code: string): string {
  const pretty = `${code.slice(0, 3)} ${code.slice(3)}`;
  return `${app ? `${app}: o` : 'O'} seu código é *${pretty}*. Expira em 5 minutos. Não partilhe.`;
}

export async function createReverse(tenantId: number, input: { to?: string | null; app?: string | null; via?: string | null }, allowed?: number[] | null) {
  const n = await pickNumber(tenantId, input.via, allowed);
  // O código não pode repetir-se entre pedidos pendentes no mesmo número.
  let text = '';
  for (let i = 0; i < 10; i++) {
    text = `${REVERSE_PREFIX}${otpCode()}`;
    const clash = await one(
      `SELECT 1 FROM otps WHERE mode = 'reverse' AND number_id = $1 AND code_hash = $2 AND status = 'pending' AND expires_at > now()`,
      [n.id, sha256(text)],
    );
    if (!clash) break;
  }
  const id = shortId('otp');
  const expires = new Date(Date.now() + config.otp.ttlSeconds * 1000);
  await query(
    `INSERT INTO otps (id, tenant_id, number_id, phone, app, mode, code_hash, status, expires_at)
     VALUES ($1,$2,$3,$4,$5,'reverse',$6,'pending',$7)`,
    [id, tenantId, n.id, input.to ? phoneDigits(input.to) : null, input.app ?? null, sha256(text), expires],
  );
  const target = phoneDigits(n.phone ?? '');
  return {
    id,
    status: 'pending',
    mode: 'reverse',
    via: n.session_name,
    code: text,
    link: target ? `https://wa.me/${target}?text=${encodeURIComponent(text)}` : null,
    expires_in: config.otp.ttlSeconds,
  };
}

export async function sendOtp(
  tenantId: number,
  input: { to: string; app?: string | null; via?: string | null; fallback?: 'reverse' | null },
  allowed?: number[] | null,
) {
  await assertCanSendMessage(await getTenant(tenantId));
  const n = await pickNumber(tenantId, input.via, allowed);
  const waha = await clientFor(n);
  const chatId = await ensureOnWhatsApp(waha, n, input.to);

  try {
    const capping = await waha.capping(n.session_name);
    if (capping.cappingStatus !== n.capping_status) {
      await query('UPDATE numbers SET capping_status = $2 WHERE id = $1', [n.id, capping.cappingStatus]);
      if (capping.cappingStatus !== 'NONE') {
        await emit(tenantId, 'number.capping', { session: n.session_name, ...capping }, { numberId: n.id, session: n.session_name });
      }
    }
    if (capping.cappingStatus === 'CAPPED') {
      if (input.fallback === 'reverse') return createReverse(tenantId, { to: input.to, app: input.app, via: n.session_name }, allowed);
      throw new ApiError(429, 'number_capped', 'Quota de novas conversas esgotada (CAPPED).');
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (!(err instanceof WahaError)) throw err; // motores sem capping: segue em frente
  }

  const code = otpCode();
  const id = shortId('otp');
  const expires = new Date(Date.now() + config.otp.ttlSeconds * 1000);
  await query(
    `INSERT INTO otps (id, tenant_id, number_id, phone, app, mode, code_hash, status, expires_at)
     VALUES ($1,$2,$3,$4,$5,'send',$6,'pending',$7)`,
    [id, tenantId, n.id, phoneDigits(input.to), input.app ?? null, sha256(`${id}:${code}`), expires],
  );
  const text = otpText(input.app, code);
  try {
    const res = await pacedSend(n, waha, chatId, text, () => waha.sendText(n.session_name, chatId, text));
    await recordOut(tenantId, n, chatId, 'otp', text.replace(/\*\d{3} \d{3}\*/, '*••• •••*'), res);
    await query(`UPDATE otps SET status = 'sent' WHERE id = $1`, [id]);
  } catch (err) {
    await query(`UPDATE otps SET status = 'failed', error = $2 WHERE id = $1`, [id, (err as Error).message]);
    throw err;
  }
  return { id, status: 'sent', via: n.session_name, expires_in: config.otp.ttlSeconds };
}

export async function verifyOtp(tenantId: number, input: { id: string; code: string }) {
  const otp = await one<any>('SELECT * FROM otps WHERE id = $1 AND tenant_id = $2', [input.id, tenantId]);
  if (!otp) throw new ApiError(404, 'otp_not_found', 'OTP não encontrado.');
  if (otp.mode === 'reverse') {
    return { id: otp.id, valid: otp.status === 'verified', status: otp.status, from: otp.verified_from };
  }
  if (otp.status === 'verified') return { id: otp.id, valid: false, status: 'already_used' };
  if (new Date(otp.expires_at) < new Date()) {
    await query(`UPDATE otps SET status = 'expired' WHERE id = $1`, [otp.id]);
    return { id: otp.id, valid: false, status: 'expired' };
  }
  if (otp.attempts >= config.otp.maxAttempts) return { id: otp.id, valid: false, status: 'too_many_attempts' };
  const ok = sha256(`${otp.id}:${String(input.code).replace(/\D/g, '')}`) === otp.code_hash;
  if (!ok) {
    await query('UPDATE otps SET attempts = attempts + 1 WHERE id = $1', [otp.id]);
    return { id: otp.id, valid: false, status: 'invalid_code', attempts_left: config.otp.maxAttempts - otp.attempts - 1 };
  }
  await query(`UPDATE otps SET status = 'verified', verified_at = now() WHERE id = $1`, [otp.id]);
  await emit(tenantId, 'otp.verified', { id: otp.id, mode: 'send', phone: otp.phone }, { numberId: otp.number_id });
  return { id: otp.id, valid: true, status: 'verified', phone: otp.phone };
}

/** Chamado pelo webhook de entrada: confirma verificação inversa se a mensagem trouxer um código válido. */
/**
 * Chamado pelo webhook de entrada: se a mensagem trouxer um código pendente deste número,
 * confirma a verificação inversa.
 * Devolve a conta dona do código, ou null.
 */
export async function handleReverseInbound(n: NumberRow, from: string, body: string): Promise<number | null> {
  const match = body.toUpperCase().match(/LSB-\d{6}/);
  if (!match) return null;
  const otp = await one<any>(
    `SELECT * FROM otps WHERE mode = 'reverse' AND code_hash = $1 AND number_id = $2 AND status = 'pending' AND expires_at > now()`,
    [sha256(match[0]), n.id],
  );
  if (!otp) return null;
  const tenantId: number = otp.tenant_id;
  if (!subscriptionActive(await getTenant(tenantId))) return tenantId;
  const fromDigits = from.endsWith('@c.us') ? from.split('@')[0] : null;
  if (otp.phone && fromDigits && otp.phone !== fromDigits) return tenantId;
  await query(`UPDATE otps SET status = 'verified', verified_at = now(), verified_from = $2 WHERE id = $1`, [otp.id, from]);
  const tn = await getNumber(tenantId, n.id);
  const waha = await clientFor(tn);
  if (n.mark_read) await waha.sendSeen(n.session_name, from).catch(() => undefined);
  await pacedSend(n, waha, from, 'Verificado ✓', () => waha.sendText(n.session_name, from, 'Verificado ✓')).catch(() => undefined);
  await emit(tenantId, 'otp.verified', { id: otp.id, mode: 'reverse', from, phone: fromDigits ?? otp.phone }, {
    numberId: n.id,
    session: n.session_name,
  });
  return tenantId;
}
