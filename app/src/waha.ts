import { config, WAHA_EVENTS } from './config.js';
import { refreshAfterUnauthorized, wahaKey } from './wahaKey.js';

export class WahaError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

export type SessionStatus =
  | 'STOPPED'
  | 'STARTING'
  | 'SCAN_QR_CODE'
  | 'PASSKEY_REQUIRED'
  | 'PASSKEY_CONFIRMATION_REQUIRED'
  | 'WORKING'
  | 'FAILED';

export interface WahaSession {
  name: string;
  status: SessionStatus;
  engine?: { engine?: string } | null;
  assignedWorker?: string;
  me?: { id: string; pushName?: string } | null;
  timestamps?: { activity: number | null };
}

export interface Capping {
  cappingStatus: 'NONE' | 'FIRST_WARNING' | 'SECOND_WARNING' | 'CAPPED' | string;
  totalQuota: number;
  usedQuota: number;
  cycleStart: number | null;
  cycleEnd: number | null;
}

export interface Timelock {
  isActive: boolean;
  enforcementType?: string;
  timeEnforcementEnds: number | null;
}

export interface WahaApiKey {
  id: string;
  key: string;
  isActive: boolean;
  isAdmin: boolean;
  session: string | null;
}

/** Ações da chave WAHA de uma conta: número próprio → controla a sessão; número Losambo → só lê e envia. */
export type KeyScope = 'customer' | 'platform';
const KEY_ACTIONS: Record<KeyScope, Record<string, boolean>> = {
  customer: { read: true, send: true, control: true, setting: true, app: false, delete: false },
  platform: { read: true, send: true, control: false, setting: false, app: false, delete: false },
};

const enc = encodeURIComponent;

function makeClient(apiKey: string | (() => string), isAdmin = false) {
  async function request(method: string, path: string, body?: unknown, accept = 'application/json', retried = false): Promise<Response> {
    const key = typeof apiKey === 'function' ? apiKey() : apiKey;
    const headers: Record<string, string> = { Accept: accept };
    if (key) headers['X-Api-Key'] = key;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(`${config.waha.url}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new WahaError(503, `WAHA indisponível em ${config.waha.url}: ${(err as Error).message}`);
    }
    // Chave admin gerada pelo WAHA: se o WAHA reiniciou, a chave mudou — relê e repete uma vez.
    if (res.status === 401 && isAdmin && !retried && (await refreshAfterUnauthorized())) {
      return request(method, path, body, accept, true);
    }
    if (!res.ok) {
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // resposta não-JSON
      }
      const msg = (parsed as any)?.message ?? (parsed as any)?.error ?? text ?? res.statusText;
      throw new WahaError(res.status, `WAHA ${method} ${path} → ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, parsed);
    }
    return res;
  }

  async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await request(method, path, body);
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  return {
    getSession: (s: string) => json<WahaSession>('GET', `/api/sessions/${enc(s)}`),
    start: (s: string) => json('POST', `/api/sessions/${enc(s)}/start`),
    stop: (s: string) => json('POST', `/api/sessions/${enc(s)}/stop`),
    restart: (s: string) => json('POST', `/api/sessions/${enc(s)}/restart`),
    logout: (s: string) => json('POST', `/api/sessions/${enc(s)}/logout`),

    capping: (s: string) => json<Capping>('GET', `/api/sessions/${enc(s)}/capping`),
    timelock: (s: string) => json<Timelock>('GET', `/api/sessions/${enc(s)}/timelock`),

    async qrPng(s: string): Promise<Buffer> {
      const res = await request('GET', `/api/${enc(s)}/auth/qr?format=image`, undefined, 'image/png');
      return Buffer.from(await res.arrayBuffer());
    },
    requestCode: (s: string, phoneNumber: string) =>
      json<{ code: string }>('POST', `/api/${enc(s)}/auth/request-code`, { phoneNumber }),

    checkExists: (s: string, phone: string) =>
      json<{ numberExists: boolean; chatId?: string }>(
        'GET',
        `/api/contacts/check-exists?session=${enc(s)}&phone=${enc(phone)}`,
      ),
    startTyping: (s: string, chatId: string) => json('POST', '/api/startTyping', { session: s, chatId }),
    stopTyping: (s: string, chatId: string) => json('POST', '/api/stopTyping', { session: s, chatId }),
    sendSeen: (s: string, chatId: string) => json('POST', '/api/sendSeen', { session: s, chatId }),
    sendText: (s: string, chatId: string, text: string) =>
      json<{ id?: string | { _serialized?: string } }>('POST', '/api/sendText', { session: s, chatId, text }),
    sendImage: (s: string, chatId: string, file: { url: string; mimetype?: string; filename?: string }, caption?: string) =>
      json<{ id?: string }>('POST', '/api/sendImage', { session: s, chatId, file, caption }),
    sendFile: (s: string, chatId: string, file: { url: string; mimetype?: string; filename?: string }, caption?: string) =>
      json<{ id?: string }>('POST', '/api/sendFile', { session: s, chatId, file, caption }),

    // Só com a chave admin (provisionamento)
    version: () => json<{ version: string; engine: string; tier: string }>('GET', '/api/server/version'),
    listSessions: () => json<WahaSession[]>('GET', '/api/sessions?all=true'),
    createSession: (name: string, start: boolean) =>
      json<WahaSession>('POST', '/api/sessions', {
        name,
        start,
        config: {
          webhooks: [
            {
              url: `${config.waha.webhookBase}/hooks/waha/${config.waha.webhookToken}`,
              events: WAHA_EVENTS,
              retries: { policy: 'exponential', delaySeconds: 2, attempts: 5 },
            },
          ],
        },
      }),
    remove: (s: string) => json('DELETE', `/api/sessions/${enc(s)}`),
    createKey: (session: string, scope: KeyScope, isActive: boolean) =>
      json<WahaApiKey>('POST', '/api/keys', { isAdmin: false, session, isActive, actions: KEY_ACTIONS[scope] }),
    setKeyActive: (id: string, session: string, scope: KeyScope, isActive: boolean) =>
      json<WahaApiKey>('PUT', `/api/keys/${enc(id)}`, { isAdmin: false, session, isActive, actions: KEY_ACTIONS[scope] }),
    deleteKey: (id: string) => json('DELETE', `/api/keys/${enc(id)}`),
  };
}

export type WahaClient = ReturnType<typeof makeClient>;

/** Cliente com a chave admin: só para criar/apagar sessões e gerir chaves. */
export const wahaAdmin = makeClient(wahaKey, true);

/** Cliente com a chave WAHA própria da conta (uma por sessão). */
export function wahaWithKey(key: string): WahaClient {
  return makeClient(key);
}

export function messageId(res: { id?: unknown } | null | undefined): string | null {
  const id = res?.id as any;
  if (!id) return null;
  if (typeof id === 'string') return id;
  return id._serialized ?? id.id ?? null;
}

export function phoneDigits(input: string): string {
  return input.replace(/[^\d]/g, '');
}

export function chatIdFor(phone: string): string {
  return `${phoneDigits(phone)}@c.us`;
}
