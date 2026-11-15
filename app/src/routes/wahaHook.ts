import { Router } from 'express';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { asyncHandler } from '../http.js';
import { safeEqual } from '../security.js';
import { handleReverseInbound } from '../services/messaging.js';
import { applySession, findBySession, platformOwner, tenantsOf, type NumberRow } from '../services/numbers.js';
import { emit } from '../services/webhooks.js';

/** Recebe os eventos do WAHA (rede interna) e entrega-os à conta certa. */
export const wahaHook = Router();

/** A conta dona do número: o cliente, num número próprio; a única conta a que o número Losambo está atribuído. */
async function routeByChat(n: NumberRow, _chatId?: string): Promise<number | null> {
  if (n.ownership === 'customer') return n.tenant_id;
  return platformOwner(n.id);
}

wahaHook.post(
  '/hooks/waha/:token',
  asyncHandler(async (req, res) => {
    if (!safeEqual(req.params.token, config.waha.webhookToken)) {
      res.status(404).end();
      return;
    }
    res.status(200).json({ ok: true });

    const { event, session, payload, me } = req.body ?? {};
    if (!event || !session) return;
    const n = await findBySession(session);
    if (!n) return;
    const opts = { numberId: n.id, session };

    if (event === 'session.status') {
      await applySession(n, { name: session, status: payload?.status, me });
      for (const t of await tenantsOf(n.id)) await emit(t, event, payload, opts);
      return;
    }
    await query('UPDATE numbers SET last_activity = now() WHERE id = $1', [n.id]);

    if (event === 'message') {
      if (!payload || payload.fromMe) return;
      const from: string = payload.from ?? '';
      const body: string = payload.body ?? '';
      const reverseTenant = await handleReverseInbound(n, from, body).catch((err) => {
        console.error('reverse OTP', err);
        return null;
      });
      const tenantId = reverseTenant ?? (await routeByChat(n, from));
      if (!tenantId) {
        console.warn(`Mensagem em ${session} de ${from} sem conta associada; ignorada.`);
        return;
      }
      await query(
        `INSERT INTO messages (tenant_id, number_id, direction, chat_id, kind, body, waha_id) VALUES ($1,$2,'in',$3,$4,$5,$6)`,
        [tenantId, n.id, from, payload.hasMedia ? 'media' : 'text', body, payload.id ?? null],
      );
      await emit(tenantId, event, payload, opts);
      return;
    }

    if (event === 'message.ack') {
      if (!payload?.id) return;
      const m = await one<{ tenant_id: number }>(
        'UPDATE messages SET ack = $2 WHERE waha_id = $1 RETURNING tenant_id',
        [payload.id, payload.ackName ?? String(payload.ack)],
      );
      if (m) await emit(m.tenant_id, event, payload, opts);
      return;
    }

    // message.reaction, call.received, …
    const chat = payload?.from ?? payload?.chatId ?? payload?.to;
    const tenantId = await routeByChat(n, chat);
    if (tenantId) await emit(tenantId, event, payload, opts);
  }),
);
