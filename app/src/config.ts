function env(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

function optionalInt(name: string): number | null {
  const v = env(name);
  if (!v) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

export const config = {
  port: Number.parseInt(env('PORT', '4000'), 10),
  databaseUrl: env('DATABASE_URL', 'postgres://losambo:losambo@localhost:5433/losambo'),
  waha: {
    url: env('WAHA_URL', 'http://localhost:3000').replace(/\/$/, ''),
    // true + WAHA_API_KEY preenchido → usa a chave fixa; senão usa a chave que o WAHA gera em cada arranque.
    useCustomKey: ['1', 'true', 'yes', 'on'].includes(env('WAHA_USE_CUSTOM_API_KEY', 'false').toLowerCase()),
    customKey: env('WAHA_API_KEY'),
    // Container de onde se lê a chave gerada (docker logs).
    container: env('WAHA_CONTAINER', 'waha'),
    webhookBase: env('WAHA_WEBHOOK_BASE', 'http://host.docker.internal:4000').replace(/\/$/, ''),
    webhookToken: env('WAHA_WEBHOOK_TOKEN', 'dev-token-change-me'),
  },
  // Cifra as chaves WAHA guardadas na base de dados.
  secretKey: env('LOSAMBO_SECRET_KEY', 'dev-only-secret-change-me'),
  publicApiUrl: env('PUBLIC_API_URL', 'http://localhost:4000/v1'),
  // Entrar com Google (OAuth 2.0 / OpenID Connect). Sem ID e segredo, o botão fica desligado.
  google: {
    clientId: env('GOOGLE_CLIENT_ID'),
    clientSecret: env('GOOGLE_CLIENT_SECRET'),
    redirectUri: env('GOOGLE_REDIRECT_URI', `http://localhost:${env('PORT', '4000')}/auth/google/callback`),
  },
  otp: {
    ttlSeconds: 300,
    maxAttempts: 5,
  },
};

export type PlanId = 'free' | 'startup' | 'business' | 'internal';

/**
 * allowOwnNumbers: pode ligar números próprios (do cliente). Os outros planos só usam
 * os números Losambo atribuídos pelo admin. maxNumbers conta só números próprios.
 */
export const plans: Record<
  PlanId,
  { label: string; allowOwnNumbers: boolean; maxNumbers: number | null; monthlyMessages: number | null }
> = {
  free: { label: 'Grátis', allowOwnNumbers: false, maxNumbers: 0, monthlyMessages: optionalInt('PLAN_FREE_MONTHLY_MESSAGES') },
  startup: { label: 'Startup', allowOwnNumbers: false, maxNumbers: 0, monthlyMessages: optionalInt('PLAN_STARTUP_MONTHLY_MESSAGES') },
  business: { label: 'Negócio', allowOwnNumbers: true, maxNumbers: null, monthlyMessages: null },
  internal: { label: 'Interno', allowOwnNumbers: true, maxNumbers: null, monthlyMessages: null },
};

/** Prefixo das sessões WAHA dos números Losambo ('_' nunca aparece nos slugs das contas). */
export const PLATFORM_SESSION_PREFIX = 'lsb_';

export const WAHA_EVENTS = ['message', 'message.ack', 'message.reaction', 'session.status', 'call.received'];
export const LOSAMBO_EVENTS = ['otp.verified', 'number.capping'];
export const ALL_EVENTS = [...WAHA_EVENTS, ...LOSAMBO_EVENTS];

export const PERMISSIONS = ['read', 'send', 'control', 'settings', 'delete'] as const;
export type Permission = (typeof PERMISSIONS)[number];
