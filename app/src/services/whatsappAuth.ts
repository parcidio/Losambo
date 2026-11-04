import { config } from '../config.js';
import { one, query } from '../db.js';
import { ApiError } from '../http.js';
import { otpCode, sha256, shortId } from '../security.js';
import { chatIdFor, wahaAdmin, WahaError } from '../waha.js';
import type { NumberRow } from './numbers.js';
import { pacedSend } from './pacing.js';

/**
 * Entrar / criar conta com WhatsApp.
 * 1. O número é confirmado no WhatsApp (GET /api/contacts/check-exists).
 * 2. Um código de 6 dígitos é enviado para esse WhatsApp a partir de um número Losambo.
 * 3. O código confirma que a pessoa controla o número; só então se entra ou se cria a conta.
 */

export type AuthPurpose = 'login' | 'signup';

const RESEND_SECONDS = 60;
const MAX_PER_PHONE_HOUR = 5;
const MAX_PER_IP_HOUR = 20;

/** Só dígitos, com indicativo. Um número angolano de 9 dígitos (9XXXXXXXX) ganha o 244. */
export function normalizePhone(input: string): string {
  let d = input.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 9 && d.startsWith('9')) d = `244${d}`;
  if (d.length < 10 || d.length > 15) {
    throw new ApiError(400, 'invalid_phone', 'Indique o número com o indicativo do país, por exemplo +244 923 000 000.');
  }
  return d;
}

export function maskPhone(d: string): string {
  return `+${d.slice(0, d.length - 9)} ••• ••• ${d.slice(-3)}`;
}

/** Número Losambo ligado (WORKING) para enviar os códigos: o definido em WHATSAPP_AUTH_SESSION ou um número Losambo, por omissão primeiro. */
async function senderNumber(): Promise<NumberRow> {
  const preferred = config.whatsappAuth.session;
  const rows = await query<NumberRow>(
    `SELECT * FROM numbers WHERE ownership = 'platform' ${preferred ? 'AND session_name = $1' : ''}
     ORDER BY is_default DESC, (status = 'WORKING') DESC, id`,
    preferred ? [preferred] : [],
  );
  for (const n of rows) {
    try {
      const s = await wahaAdmin.getSession(n.session_name);
      if (s.status === 'WORKING') return n;
    } catch (err) {
      if (!(err instanceof WahaError)) throw err;
    }
  }
  throw new ApiError(
    503,
    'whatsapp_unavailable',
    'A entrada com WhatsApp está indisponível de momento (nenhum número Losambo ligado). Use o e-mail.',
  );
}

async function assertRateLimits(phone: string, ip: string | null): Promise<void> {
  const last = await one<{ age: number; hour: number }>(
    `SELECT extract(epoch FROM now() - max(created_at))::int AS age,
            count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS hour
     FROM auth_codes WHERE phone = $1`,
    [phone],
  );
  if (last && last.age !== null && last.age < RESEND_SECONDS) {
    throw new ApiError(429, 'too_soon', `Aguarde ${RESEND_SECONDS - last.age} s para pedir outro código.`);
  }
  if (last && last.hour >= MAX_PER_PHONE_HOUR) {
    throw new ApiError(429, 'too_many_codes', 'Demasiados códigos pedidos para este número. Tente daqui a uma hora.');
  }
  if (ip) {
    const r = await one<{ c: number }>(`SELECT count(*)::int AS c FROM auth_codes WHERE ip = $1 AND created_at > now() - interval '1 hour'`, [ip]);
    if (r && r.c >= MAX_PER_IP_HOUR) throw new ApiError(429, 'too_many_codes', 'Demasiados pedidos. Tente daqui a uma hora.');
  }
}

export async function startWhatsAppAuth(input: {
  phone: string;
  purpose: AuthPurpose;
  payload?: Record<string, unknown>;
  ip: string | null;
}): Promise<{ id: string; phone: string; expires_in: number; resend_in: number }> {
  const phone = normalizePhone(input.phone);
  const user = await one<{ id: number }>('SELECT id FROM users WHERE phone = $1', [phone]);
  if (input.purpose === 'login' && !user) {
    throw new ApiError(404, 'no_account', 'Não existe nenhuma conta com este número WhatsApp. Crie uma conta.');
  }
  if (input.purpose === 'signup' && user) {
    throw new ApiError(409, 'phone_taken', 'Já existe uma conta com este número WhatsApp. Entre com ele.');
  }
  await assertRateLimits(phone, input.ip);

  const n = await senderNumber();
  const exists = await wahaAdmin.checkExists(n.session_name, phone);
  if (!exists.numberExists) {
    throw new ApiError(404, 'not_on_whatsapp', 'Este número não tem WhatsApp. Verifique o número e o indicativo.');
  }
  const chatId = exists.chatId ?? chatIdFor(phone);

  const id = shortId('auth');
  const code = otpCode();
  const ttl = config.otp.ttlSeconds;
  await query(
    `INSERT INTO auth_codes (id, phone, purpose, payload, code_hash, number_id, ip, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(secs => $8))`,
    [id, phone, input.purpose, input.payload ?? null, sha256(`${id}:${code}`), n.id, input.ip, ttl],
  );
  const text =
    `Losambo: o seu código ${input.purpose === 'signup' ? 'para criar conta' : 'de entrada'} é *${code.slice(0, 3)} ${code.slice(3)}*. ` +
    `Expira em ${Math.round(ttl / 60)} minutos. Não partilhe este código.`;
  try {
    await pacedSend(n, wahaAdmin, chatId, text, () => wahaAdmin.sendText(n.session_name, chatId, text));
  } catch (err) {
    await query('DELETE FROM auth_codes WHERE id = $1', [id]);
    throw err;
  }
  return { id, phone: maskPhone(phone), expires_in: ttl, resend_in: RESEND_SECONDS };
}

/** Confirma o código. Devolve o pedido (telefone, finalidade e dados do registo) ou lança um erro. */
export async function verifyWhatsAppAuth(input: { id: string; code: string }): Promise<{
  phone: string;
  purpose: AuthPurpose;
  payload: Record<string, any> | null;
}> {
  const row = await one<any>('SELECT *, expires_at < now() AS expired FROM auth_codes WHERE id = $1', [input.id]);
  if (!row || row.used_at) throw new ApiError(400, 'code_invalid', 'Pedido inválido. Peça um novo código.');
  if (row.expired) throw new ApiError(400, 'code_expired', 'O código expirou. Peça um novo código.');
  if (row.attempts >= config.otp.maxAttempts) throw new ApiError(429, 'too_many_attempts', 'Demasiadas tentativas. Peça um novo código.');
  const ok = sha256(`${row.id}:${String(input.code).replace(/\D/g, '')}`) === row.code_hash;
  if (!ok) {
    await query('UPDATE auth_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
    const left = config.otp.maxAttempts - row.attempts - 1;
    throw new ApiError(400, 'code_wrong', left > 0 ? `Código errado. Restam ${left} tentativas.` : 'Código errado. Peça um novo código.');
  }
  const used = await one('UPDATE auth_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id', [row.id]);
  if (!used) throw new ApiError(400, 'code_invalid', 'Este código já foi usado.');
  return { phone: row.phone, purpose: row.purpose, payload: row.payload };
}
