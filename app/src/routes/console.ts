import { assertSafeUrl } from '../net.js';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { endSession, requireAdmin, requireUser, startSession } from '../auth.js';
import { ALL_EVENTS, config, PERMISSIONS, plans } from '../config.js';
import { one, query } from '../db.js';
import { ApiError, asyncHandler, parse } from '../http.js';
import { hashPassword, sha256, token, verifyPassword } from '../security.js';
import { createReverse, sendMessage, sendOtp, verifyOtp } from '../services/messaging.js';
import {
  adminControl,
  assertCustomerNumber,
  clientFor,
  control,
  createNumber,
  createPlatformNumber,
  deleteNumber,
  getNumber,
  getNumberRow,
  health,
  listNumbers,
  listNumbersLive,
  listPlatformNumbers,
  setPlatformAssignments,
  syncTenantKeys,
  updateSettings,
} from '../services/numbers.js';
import { createAccount } from '../services/accounts.js';
import { setSubscription } from '../services/subscriptions.js';
import { googleEnabled } from './googleAuth.js';
import { startWhatsAppAuth, verifyWhatsAppAuth } from '../services/whatsappAuth.js';
import { effectivePlan, getTenant, subscriptionActive } from '../services/tenants.js';
import { emit, getEndpoint, rotateSecret, saveEndpoint } from '../services/webhooks.js';
import { phoneDigits, wahaAdmin } from '../waha.js';
import { wahaKey, wahaKeySource } from '../wahaKey.js';

export const consoleApi = Router();

function tid(req: Request): number {
  return req.user!.tenant_id;
}

/** Nunca devolver a chave WAHA (mesmo cifrada) ao browser. */
function strip<T extends object>(n: T): Omit<T, 'waha_key_enc'> {
  const copy = { ...n } as T & { waha_key_enc?: unknown };
  delete copy.waha_key_enc;
  return copy;
}

// Autenticação

consoleApi.post(
  '/auth/signup',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().min(2).max(80),
        company: z.string().min(2).max(80),
        email: z.string().email().max(160),
        password: z.string().min(8).max(200),
      }),
      req.body,
    );
    const email = body.email.toLowerCase();
    if (await one('SELECT 1 FROM users WHERE email = $1', [email])) {
      throw new ApiError(409, 'email_taken', 'Já existe uma conta com este e-mail.');
    }
    const { userId } = await createAccount({
      name: body.name,
      company: body.company,
      email: email,
      passwordHash: await hashPassword(body.password),
    });
    await startSession(res, userId);
    res.status(201).json({ ok: true });
  }),
);

consoleApi.get('/auth/providers', (_req, res) => {
  res.json({ google: googleEnabled(), whatsapp: true });
});

// Entrar / criar conta com WhatsApp: check-exists no WAHA → código enviado por WhatsApp → confirmação.
consoleApi.post(
  '/auth/whatsapp/start',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.discriminatedUnion('mode', [
        z.object({ mode: z.literal('login'), phone: z.string().min(6).max(32) }),
        z.object({
          mode: z.literal('signup'),
          phone: z.string().min(6).max(32),
          name: z.string().trim().min(2).max(80),
          company: z.string().trim().min(2).max(80),
        }),
      ]),
      req.body,
    );
    const r = await startWhatsAppAuth({
      phone: body.phone,
      purpose: body.mode,
      payload: body.mode === 'signup' ? { name: body.name, company: body.company } : undefined,
      ip: req.ip ?? null,
    });
    res.status(202).json(r);
  }),
);

consoleApi.post(
  '/auth/whatsapp/verify',
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ id: z.string().min(1).max(64), code: z.string().min(4).max(12) }), req.body);
    const r = await verifyWhatsAppAuth(body);
    let user = await one<{ id: number }>('SELECT id FROM users WHERE phone = $1', [r.phone]);
    if (r.purpose === 'login') {
      if (!user) throw new ApiError(404, 'no_account', 'Não existe nenhuma conta com este número WhatsApp.');
    } else {
      if (user) throw new ApiError(409, 'phone_taken', 'Já existe uma conta com este número WhatsApp. Entre com ele.');
      const { userId } = await createAccount({
        name: r.payload?.name,
        company: r.payload?.company,
        email: null,
        phone: r.phone,
        passwordHash: null,
      });
      user = { id: userId };
    }
    await startSession(res, user.id);
    res.status(r.purpose === 'signup' ? 201 : 200).json({ ok: true });
  }),
);

consoleApi.post(
  '/auth/login',
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
    const u = await one<{ id: number; password_hash: string | null }>('SELECT id, password_hash FROM users WHERE email = $1', [
      body.email.toLowerCase(),
    ]);
    if (u && !u.password_hash) {
      throw new ApiError(401, 'no_password', 'Esta conta não tem palavra-passe. Entre com o Google ou com o WhatsApp.');
    }
    if (!u || !(await verifyPassword(body.password, u.password_hash!))) {
      throw new ApiError(401, 'invalid_credentials', 'E-mail ou palavra-passe errados.');
    }
    await startSession(res, u.id);
    res.json({ ok: true });
  }),
);

consoleApi.post(
  '/auth/logout',
  asyncHandler(async (req, res) => {
    await endSession(req, res);
    res.json({ ok: true });
  }),
);

consoleApi.use(requireUser);

consoleApi.get(
  '/me',
  asyncHandler(async (req, res) => {
    const t = await getTenant(tid(req));
    const plan = effectivePlan(t);
    res.json({
      user: req.user,
      tenant: { ...t, plan_effective: plan, plan_label: plans[plan].label, limits: plans[plan] },
      subscription: { active: subscriptionActive(t), status: t.subscription_status, ends_at: t.subscription_ends_at },
      publicApiUrl: config.publicApiUrl,
    });
  }),
);

consoleApi.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const [numbers, ep, otpStats, msgStats] = await Promise.all([
      listNumbersLive(tid(req)),
      getEndpoint(tid(req)),
      one(
        `SELECT count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS day,
                count(*) FILTER (WHERE status = 'verified' AND created_at > now() - interval '24 hours')::int AS verified
         FROM otps WHERE tenant_id = $1`,
        [tid(req)],
      ),
      one(`SELECT count(*)::int AS month FROM messages WHERE tenant_id = $1 AND direction = 'out' AND created_at >= date_trunc('month', now())`, [
        tid(req),
      ]),
    ]);
    let wahaOk = true;
    try {
      await wahaAdmin.version();
    } catch {
      wahaOk = false;
    }
    res.json({ numbers: numbers.map(strip), webhook: ep ? { url: ep.url, events: ep.events } : null, otp: otpStats, messages: msgStats, waha: wahaOk });
  }),
);

// Números

consoleApi.get(
  '/numbers',
  asyncHandler(async (req, res) => {
    res.json((await listNumbersLive(tid(req))).map(strip));
  }),
);

consoleApi.post(
  '/numbers',
  asyncHandler(async (req, res) => {
    res.status(201).json(strip(await createNumber(tid(req))));
  }),
);

consoleApi.get(
  '/numbers/:id/health',
  asyncHandler(async (req, res) => {
    const h = await health(await getNumber(tid(req), req.params.id));
    res.json({ ...h, number: strip(h.number) });
  }),
);

consoleApi.get(
  '/numbers/:id/qr',
  asyncHandler(async (req, res) => {
    const n = await getNumber(tid(req), req.params.id);
    assertCustomerNumber(n);
    res.set('Cache-Control', 'no-store').type('png').send(await (await clientFor(n)).qrPng(n.session_name));
  }),
);

consoleApi.post(
  '/numbers/:id/pairing-code',
  asyncHandler(async (req, res) => {
    const { phone } = parse(z.object({ phone: z.string().min(6) }), req.body);
    const n = await getNumber(tid(req), req.params.id);
    assertCustomerNumber(n);
    res.json(await (await clientFor(n)).requestCode(n.session_name, phoneDigits(phone)));
  }),
);

consoleApi.post(
  '/numbers/:id/:action(start|stop|restart|logout)',
  asyncHandler(async (req, res) => {
    const n = await getNumber(tid(req), req.params.id);
    res.json(strip(await control(n, req.params.action as 'start' | 'stop' | 'restart' | 'logout')));
  }),
);

consoleApi.patch(
  '/numbers/:id',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({ typing: z.boolean().optional(), mark_read: z.boolean().optional(), max_per_minute: z.number().int().min(1).max(60).optional() }),
      req.body,
    );
    const n = await getNumber(tid(req), req.params.id);
    assertCustomerNumber(n);
    res.json(await updateSettings(n, body));
  }),
);

consoleApi.delete(
  '/numbers/:id',
  asyncHandler(async (req, res) => {
    const n = await getNumber(tid(req), req.params.id);
    assertCustomerNumber(n);
    await deleteNumber(n);
    res.status(204).end();
  }),
);

// Monitor de eventos

consoleApi.get(
  '/events',
  asyncHandler(async (req, res) => {
    const after = Number(req.query.after ?? 0) || 0;
    const rows = await query(
      `SELECT id, session_name, event, payload, delivery, created_at FROM events
       WHERE tenant_id = $1 AND id > $2 ORDER BY id DESC LIMIT 100`,
      [tid(req), after],
    );
    res.json(rows);
  }),
);

// OTP e mensagens (testes a partir da consola)

consoleApi.get(
  '/otps',
  asyncHandler(async (req, res) => {
    res.json(
      await query(
        `SELECT o.id, o.phone, o.app, o.mode, o.status, o.attempts, o.verified_from, o.error, o.expires_at, o.verified_at, o.created_at,
                n.session_name FROM otps o LEFT JOIN numbers n ON n.id = o.number_id
         WHERE o.tenant_id = $1 ORDER BY o.created_at DESC LIMIT 100`,
        [tid(req)],
      ),
    );
  }),
);

consoleApi.post(
  '/otps/send',
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ to: z.string().min(6), app: z.string().optional(), via: z.string().optional(), fallback: z.enum(['reverse']).optional() }), req.body);
    res.status(202).json(await sendOtp(tid(req), body));
  }),
);

consoleApi.post(
  '/otps/reverse',
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ to: z.string().optional(), app: z.string().optional(), via: z.string().optional() }), req.body ?? {});
    res.status(201).json(await createReverse(tid(req), body));
  }),
);

consoleApi.post(
  '/otps/verify',
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ id: z.string(), code: z.string().default('') }), req.body);
    res.json(await verifyOtp(tid(req), body));
  }),
);

consoleApi.get(
  '/messages',
  asyncHandler(async (req, res) => {
    res.json(
      await query(
        `SELECT m.id, m.direction, m.chat_id, m.kind, m.body, m.ack, m.created_at, n.session_name
         FROM messages m LEFT JOIN numbers n ON n.id = m.number_id WHERE m.tenant_id = $1 ORDER BY m.created_at DESC LIMIT 100`,
        [tid(req)],
      ),
    );
  }),
);

consoleApi.post(
  '/messages',
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ to: z.string().min(6), text: z.string().min(1).max(4096), via: z.string().optional() }), req.body);
    res.status(202).json(await sendMessage(tid(req), { type: 'text', ...body }));
  }),
);

// Webhooks

consoleApi.get(
  '/webhook',
  asyncHandler(async (req, res) => {
    const ep = await getEndpoint(tid(req));
    res.json({
      endpoint: ep ? { ...ep, secret: `whsec_${'•'.repeat(16)}` } : null,
      events: ALL_EVENTS,
    });
  }),
);

consoleApi.get(
  '/webhook/secret',
  asyncHandler(async (req, res) => {
    const ep = await getEndpoint(tid(req));
    if (!ep) throw new ApiError(404, 'no_webhook', 'Guarde primeiro o endpoint.');
    res.json({ secret: ep.secret });
  }),
);

consoleApi.put(
  '/webhook',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        url: z.string().url(),
        events: z.array(z.enum(ALL_EVENTS as [string, ...string[]])).min(1),
        retry_policy: z.enum(['exponential', 'linear', 'constant']),
        attempts: z.number().int().min(1).max(30),
        delay_seconds: z.number().int().min(1).max(3600),
      }),
      req.body,
    );
    assertSafeUrl(body.url);
    const ep = await saveEndpoint(tid(req), body);
    res.json({ ...ep, secret: undefined });
  }),
);

consoleApi.post(
  '/webhook/rotate',
  asyncHandler(async (req, res) => {
    const ep = await rotateSecret(tid(req));
    if (!ep) throw new ApiError(404, 'no_webhook', 'Guarde primeiro o endpoint.');
    res.json({ secret: ep.secret });
  }),
);

consoleApi.post(
  '/webhook/test',
  asyncHandler(async (req, res) => {
    if (!(await getEndpoint(tid(req)))) throw new ApiError(404, 'no_webhook', 'Guarde primeiro o endpoint.');
    const id = await emit(
      tid(req),
      'message',
      { test: true, from: '2449XXXXXXXX@c.us', body: 'LSB-482913', fromMe: false },
      { session: 'teste', force: true },
    );
    res.json({ id });
  }),
);

// Chaves API

consoleApi.get(
  '/keys',
  asyncHandler(async (req, res) => {
    res.json(
      await query(
        'SELECT id, name, env, display, permissions, number_ids, active, last_used_at, created_at FROM api_keys WHERE tenant_id = $1 ORDER BY id',
        [tid(req)],
      ),
    );
  }),
);

const keyBody = z.object({
  name: z.string().min(1).max(80),
  env: z.enum(['live', 'test']).default('live'),
  permissions: z.array(z.enum(PERMISSIONS)).min(1),
  number_ids: z.array(z.number().int()).nullable().default(null),
});

consoleApi.post(
  '/keys',
  asyncHandler(async (req, res) => {
    const body = parse(keyBody, req.body);
    const secret = `lsb_${body.env}_${token(24)}`;
    const display = `lsb_${body.env}_…${secret.slice(-4)}`;
    const row = await one(
      `INSERT INTO api_keys (tenant_id, name, env, display, key_hash, permissions, number_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, env, display, permissions, number_ids, active, created_at`,
      [tid(req), body.name, body.env, display, sha256(secret), body.permissions, body.number_ids?.length ? body.number_ids : null],
    );
    res.status(201).json({ ...row, secret });
  }),
);

consoleApi.patch(
  '/keys/:id',
  asyncHandler(async (req, res) => {
    const body = parse(keyBody.partial().extend({ active: z.boolean().optional() }), req.body);
    const row = await one(
      `UPDATE api_keys SET name = COALESCE($3, name), permissions = COALESCE($4, permissions),
         number_ids = CASE WHEN $5::boolean THEN $6::int[] ELSE number_ids END, active = COALESCE($7, active)
       WHERE id = $1 AND tenant_id = $2 RETURNING id, name, env, display, permissions, number_ids, active, created_at`,
      [
        req.params.id,
        tid(req),
        body.name ?? null,
        body.permissions ?? null,
        body.number_ids !== undefined,
        body.number_ids?.length ? body.number_ids : null,
        body.active ?? null,
      ],
    );
    if (!row) throw new ApiError(404, 'key_not_found');
    res.json(row);
  }),
);

consoleApi.delete(
  '/keys/:id',
  asyncHandler(async (req, res) => {
    await query('DELETE FROM api_keys WHERE id = $1 AND tenant_id = $2', [req.params.id, tid(req)]);
    res.status(204).end();
  }),
);

// Administração (super-admin)

consoleApi.get(
  '/admin/tenants',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json(
      await query(
        `SELECT t.*, (SELECT count(*)::int FROM numbers n WHERE n.tenant_id = t.id) AS numbers,
                (SELECT count(*)::int FROM messages m WHERE m.tenant_id = t.id AND m.direction = 'out'
                   AND m.created_at >= date_trunc('month', now())) AS messages_month
         FROM tenants t ORDER BY t.id`,
      ),
    );
  }),
);

consoleApi.put(
  '/admin/tenants/:id/plan',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        plan: z.enum(['free', 'startup', 'business', 'internal']),
        reason: z.string().max(80).nullable().optional(),
        until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      }),
      req.body,
    );
    const internal = body.plan === 'internal';
    const row = await one(
      'UPDATE tenants SET plan = $2, plan_reason = $3, plan_until = $4 WHERE id = $1 RETURNING *',
      [req.params.id, body.plan, internal ? body.reason ?? 'Projeto próprio' : null, internal ? body.until ?? null : null],
    );
    if (!row) throw new ApiError(404, 'tenant_not_found');
    // O plano Interno conta como subscrição ativa: sincroniza as chaves WAHA.
    const keys = await syncTenantKeys(Number(req.params.id));
    res.json({ ...row, keys });
  }),
);

consoleApi.put(
  '/admin/tenants/:id/subscription',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        status: z.enum(['inactive', 'active', 'expired', 'canceled']),
        ends_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      }),
      req.body,
    );
    const endsAt = body.ends_at ? `${body.ends_at}T23:59:59Z` : null;
    res.json(await setSubscription(Number(req.params.id), body.status, endsAt));
  }),
);

consoleApi.get(
  '/admin/tenants/:id/waha-keys',
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(
      await query(
        `SELECT n.id, n.session_name, n.ownership, n.status, n.phone, a.waha_key_id, a.waha_key_active
         FROM number_assignments a JOIN numbers n ON n.id = a.number_id WHERE a.tenant_id = $1 ORDER BY n.ownership, n.id`,
        [req.params.id],
      ),
    );
  }),
);

consoleApi.post(
  '/admin/tenants/:id/waha-keys/sync',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const t = await getTenant(Number(req.params.id));
    res.json(await syncTenantKeys(t.id));
  }),
);

// Números Losambo (da plataforma) — partilhados pelas contas a que forem atribuídos

async function platformNumber(id: string) {
  const n = await getNumberRow(id);
  if (n.ownership !== 'platform') throw new ApiError(404, 'number_not_found', 'Número Losambo não encontrado');
  return n;
}

consoleApi.get(
  '/admin/platform-numbers',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await listPlatformNumbers());
  }),
);

consoleApi.post(
  '/admin/platform-numbers',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.status(201).json(await createPlatformNumber());
  }),
);

consoleApi.get(
  '/admin/platform-numbers/:id/qr',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const n = await platformNumber(req.params.id);
    res.set('Cache-Control', 'no-store').type('png').send(await wahaAdmin.qrPng(n.session_name));
  }),
);

consoleApi.post(
  '/admin/platform-numbers/:id/pairing-code',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { phone } = parse(z.object({ phone: z.string().min(6) }), req.body);
    const n = await platformNumber(req.params.id);
    res.json(await wahaAdmin.requestCode(n.session_name, phoneDigits(phone)));
  }),
);

consoleApi.post(
  '/admin/platform-numbers/:id/:action(start|stop|restart|logout)',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const n = await platformNumber(req.params.id);
    res.json(await adminControl(n, req.params.action as 'start' | 'stop' | 'restart' | 'logout'));
  }),
);

consoleApi.patch(
  '/admin/platform-numbers/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        is_default: z.boolean().optional(),
        typing: z.boolean().optional(),
        mark_read: z.boolean().optional(),
        max_per_minute: z.number().int().min(1).max(60).optional(),
      }),
      req.body,
    );
    res.json(await updateSettings(await platformNumber(req.params.id), body));
  }),
);

consoleApi.delete(
  '/admin/platform-numbers/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    await deleteNumber(await platformNumber(req.params.id));
    res.status(204).end();
  }),
);

consoleApi.get(
  '/admin/tenants/:id/numbers',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const assigned = await listNumbers(Number(req.params.id));
    res.json({
      platform: await listPlatformNumbers(),
      assigned: assigned.map((n) => n.id),
      own: assigned.filter((n) => n.ownership === 'customer').map(strip),
    });
  }),
);

consoleApi.put(
  '/admin/tenants/:id/numbers',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { number_ids } = parse(z.object({ number_ids: z.array(z.number().int()) }), req.body);
    const rows = await setPlatformAssignments(Number(req.params.id), number_ids);
    res.json(rows.map(strip));
  }),
);

consoleApi.get(
  '/admin/waha',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const [version, sessions] = await Promise.allSettled([wahaAdmin.version(), wahaAdmin.listSessions()]);
    res.json({
      url: config.waha.url,
      version: version.status === 'fulfilled' ? version.value : null,
      error: version.status === 'rejected' ? (version.reason as Error).message : null,
      sessions: sessions.status === 'fulfilled' ? sessions.value.map((s) => ({ name: s.name, status: s.status })) : [],
      adminKeyConfigured: !!wahaKey(),
      adminKeySource: wahaKeySource(),
    });
  }),
);
