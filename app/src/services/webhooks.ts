import { safeRequest } from '../net.js';
import { one, query } from '../db.js';
import { hmacSignature, token } from '../security.js';

export interface WebhookEndpoint {
  tenant_id: number;
  url: string;
  events: string[];
  secret: string;
  retry_policy: 'exponential' | 'linear' | 'constant';
  attempts: number;
  delay_seconds: number;
}

export async function getEndpoint(tenantId: number): Promise<WebhookEndpoint | null> {
  return one<WebhookEndpoint>('SELECT * FROM webhook_endpoints WHERE tenant_id = $1', [tenantId]);
}

export async function saveEndpoint(
  tenantId: number,
  data: Pick<WebhookEndpoint, 'url' | 'events' | 'retry_policy' | 'attempts' | 'delay_seconds'>,
): Promise<WebhookEndpoint> {
  const row = await one<WebhookEndpoint>(
    `INSERT INTO webhook_endpoints (tenant_id, url, events, secret, retry_policy, attempts, delay_seconds)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id) DO UPDATE SET url = $2, events = $3, retry_policy = $5, attempts = $6,
       delay_seconds = $7, updated_at = now()
     RETURNING *`,
    [tenantId, data.url, data.events, `whsec_${token(24)}`, data.retry_policy, data.attempts, data.delay_seconds],
  );
  return row!;
}

export async function rotateSecret(tenantId: number): Promise<WebhookEndpoint | null> {
  return one<WebhookEndpoint>(
    'UPDATE webhook_endpoints SET secret = $2, updated_at = now() WHERE tenant_id = $1 RETURNING *',
    [tenantId, `whsec_${token(24)}`],
  );
}

function backoff(ep: WebhookEndpoint, attempt: number): number {
  const base = Math.max(1, ep.delay_seconds) * 1000;
  if (ep.retry_policy === 'constant') return base;
  if (ep.retry_policy === 'linear') return base * attempt;
  return Math.min(base * 2 ** (attempt - 1), 60 * 60 * 1000);
}

async function deliver(ep: WebhookEndpoint, eventId: number, body: string, attempt: number): Promise<void> {
  let result: string;
  try {
    const res = await safeRequest(ep.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Losambo-Webhooks/1.0',
        'X-Losambo-Signature': hmacSignature(ep.secret, body),
        'X-Losambo-Event-Id': String(eventId),
      },
      body,
      timeoutMs: 10_000,
      maxBytes: 64 * 1024,
    });
    result = `${res.status}`;
    if (res.status >= 200 && res.status < 300) {
      await query('UPDATE events SET delivery = $2 WHERE id = $1', [eventId, `entregue · ${result}`]);
      return;
    }
  } catch (err) {
    result = (err as Error).message;
  }
  if (attempt < ep.attempts) {
    await query('UPDATE events SET delivery = $2 WHERE id = $1', [eventId, `tentativa ${attempt} falhou (${result})`]);
    setTimeout(() => void deliver(ep, eventId, body, attempt + 1), backoff(ep, attempt)).unref();
  } else {
    await query('UPDATE events SET delivery = $2 WHERE id = $1', [eventId, `falhou após ${attempt} tentativas (${result})`]);
  }
}

/**
 * Regista o evento e, se o cliente o subscreveu, entrega-o no seu servidor com assinatura HMAC.
 */
export async function emit(
  tenantId: number,
  event: string,
  payload: unknown,
  opts: { numberId?: number | null; session?: string | null; force?: boolean } = {},
): Promise<number> {
  const ep = await getEndpoint(tenantId);
  const subscribed = !!ep && (opts.force || ep.events.includes(event));
  const row = await one<{ id: number }>(
    `INSERT INTO events (tenant_id, number_id, session_name, event, payload, delivery)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [tenantId, opts.numberId ?? null, opts.session ?? null, event, JSON.stringify(payload ?? {}), subscribed ? 'a enviar' : null],
  );
  if (ep && subscribed) {
    const body = JSON.stringify({
      id: row!.id,
      event,
      session: opts.session ?? null,
      timestamp: Date.now(),
      payload,
    });
    void deliver(ep, row!.id, body, 1);
  }
  return row!.id;
}
