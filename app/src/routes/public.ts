import { Router, type Request } from 'express';
import { z } from 'zod';
import { can, requireApiKey } from '../auth.js';
import { ApiError, asyncHandler, parse } from '../http.js';
import { createReverse, pickNumber, sendMessage, sendOtp, verifyOtp } from '../services/messaging.js';
import { assertCustomerNumber, clientFor, control, createNumber, deleteNumber, getNumber, health, listNumbersLive } from '../services/numbers.js';
import { assertSubscriptionActive } from '../services/tenants.js';
import { phoneDigits } from '../waha.js';

export const publicApi = Router();
publicApi.use(requireApiKey);

// A API só está disponível com a subscrição ativa.
publicApi.use(
  asyncHandler(async (req, _res, next) => {
    await assertSubscriptionActive(req.apiKey!.tenant_id);
    next();
  }),
);

function tenant(req: Request): number {
  return req.apiKey!.tenant_id;
}

async function allowedNumber(req: Request) {
  const n = await getNumber(tenant(req), req.params.id);
  const allowed = req.apiKey!.number_ids;
  if (allowed && !allowed.includes(n.id)) throw new ApiError(403, 'number_not_allowed', 'Esta chave não pode usar este número.');
  return n;
}

/** QR, emparelhamento, reinício e apagar só se aplicam a números próprios (plano Negócio). */
async function ownNumber(req: Request) {
  const n = await allowedNumber(req);
  assertCustomerNumber(n);
  return n;
}

function numberView(n: Awaited<ReturnType<typeof getNumber>>) {
  return {
    id: n.session_name,
    type: n.ownership === 'platform' ? 'losambo' : 'own',
    phone: n.phone,
    name: n.me_name,
    status: n.status,
    engine: n.engine,
    capping: n.capping_status,
    connected_since: n.connected_since,
    last_activity: n.last_activity,
  };
}

publicApi.get(
  '/numbers',
  can('read'),
  asyncHandler(async (req, res) => {
    const allowed = req.apiKey!.number_ids;
    const rows = (await listNumbersLive(tenant(req))).filter((n) => !allowed || allowed.includes(n.id));
    res.json(rows.map(numberView));
  }),
);

publicApi.post(
  '/numbers',
  can('control'),
  asyncHandler(async (req, res) => {
    const n = await createNumber(tenant(req));
    res.status(201).json(numberView(n));
  }),
);

publicApi.get(
  '/numbers/:id/qr',
  can('control'),
  asyncHandler(async (req, res) => {
    const n = await ownNumber(req);
    const png = await (await clientFor(n)).qrPng(n.session_name);
    if (req.accepts(['image/png', 'json']) === 'image/png') {
      res.type('png').send(png);
    } else {
      res.json({ mimetype: 'image/png', data: png.toString('base64') });
    }
  }),
);

publicApi.post(
  '/numbers/:id/pairing-code',
  can('control'),
  asyncHandler(async (req, res) => {
    const { phone } = parse(z.object({ phone: z.string().min(6) }), req.body);
    const n = await ownNumber(req);
    res.json(await (await clientFor(n)).requestCode(n.session_name, phoneDigits(phone)));
  }),
);

publicApi.get(
  '/numbers/:id/health',
  can('read'),
  asyncHandler(async (req, res) => {
    const h = await health(await allowedNumber(req));
    res.json({ ...numberView(h.number), quota: h.capping, timelock: h.timelock, warnings: h.errors });
  }),
);

publicApi.post(
  '/numbers/:id/restart',
  can('control'),
  asyncHandler(async (req, res) => {
    res.json(numberView(await control(await ownNumber(req), 'restart')));
  }),
);

publicApi.delete(
  '/numbers/:id',
  can('delete'),
  asyncHandler(async (req, res) => {
    await deleteNumber(await ownNumber(req));
    res.status(204).end();
  }),
);

const otpSend = z.object({
  to: z.string().min(6),
  app: z.string().max(40).optional(),
  via: z.string().optional(),
  fallback: z.enum(['reverse']).optional(),
});

publicApi.post(
  '/otp/send',
  can('send'),
  asyncHandler(async (req, res) => {
    const body = parse(otpSend, req.body);
    res.status(202).json(await sendOtp(tenant(req), body, req.apiKey!.number_ids));
  }),
);

publicApi.post(
  '/otp/reverse',
  can('send'),
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ to: z.string().optional(), app: z.string().optional(), via: z.string().optional() }), req.body ?? {});
    res.status(201).json(await createReverse(tenant(req), body, req.apiKey!.number_ids));
  }),
);

publicApi.post(
  '/otp/verify',
  can('send'),
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ id: z.string(), code: z.string().optional().default('') }), req.body);
    res.json(await verifyOtp(tenant(req), body));
  }),
);

const fileSchema = z.object({ url: z.string().url(), mimetype: z.string().optional(), filename: z.string().optional() });
const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), to: z.string().min(6), via: z.string().optional(), text: z.string().min(1).max(4096) }),
  z.object({ type: z.literal('image'), to: z.string().min(6), via: z.string().optional(), file: fileSchema, caption: z.string().optional() }),
  z.object({ type: z.literal('file'), to: z.string().min(6), via: z.string().optional(), file: fileSchema, caption: z.string().optional() }),
]);

publicApi.post(
  '/messages',
  can('send'),
  asyncHandler(async (req, res) => {
    const raw = { type: 'text', ...req.body };
    const body = parse(messageSchema, raw);
    res.status(202).json(await sendMessage(tenant(req), body, req.apiKey!.number_ids));
  }),
);

publicApi.get(
  '/contacts/:phone',
  can('read'),
  asyncHandler(async (req, res) => {
    const n = await pickNumber(tenant(req), (req.query.via as string) || null, req.apiKey!.number_ids);
    const r = await (await clientFor(n)).checkExists(n.session_name, phoneDigits(req.params.phone));
    res.json({ phone: phoneDigits(req.params.phone), on_whatsapp: r.numberExists, chat_id: r.chatId ?? null });
  }),
);
