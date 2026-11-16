function env(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const v = env(name).toLowerCase();
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on', 'sim'].includes(v);
}

function intEnv(name: string, fallback: number): number {
  const n = Number.parseInt(env(name), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Limite opcional: vazio → valor por omissão; "ilimitado"/"unlimited" → sem limite (null). */
function limitEnv(name: string, fallback: number | null): number | null {
  const v = env(name).toLowerCase();
  if (!v) return fallback;
  if (v === 'ilimitado' || v === 'unlimited' || v === 'none') return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: Number.parseInt(env('PORT', '4000'), 10),
  databaseUrl: env('DATABASE_URL', 'postgres://losambo:losambo@localhost:5433/losambo'),
  // DATABASE_SSL: true para bases geridas (Supabase…), false para o PostgreSQL da própria stack; vazio = segue o sslmode do URL.
  databaseSsl: ((v) => (v === '' ? undefined : ['1', 'true', 'yes', 'on'].includes(v)))(env('DATABASE_SSL').toLowerCase()),
  // Palavra-passe do utilizador "waha" no PostgreSQL da stack (a Losambo cria/atualiza o utilizador ao arrancar).
  wahaDbPassword: env('WAHA_DB_PASSWORD'),
  databasePoolMax: Number.parseInt(env('DATABASE_POOL_MAX', '10'), 10),
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
  // Atrás do proxy do Coolify (HTTPS): cookies "Secure" e IP real do cliente (X-Forwarded-For).
  secureCookies: env('PUBLIC_API_URL', '').startsWith('https://'),
  trustProxy: Number.parseInt(env('TRUST_PROXY', '0'), 10),
  // Só em desenvolvimento: deixa webhooks e ficheiros apontar para localhost/redes privadas.
  allowPrivateUrls: ['1', 'true', 'yes', 'on'].includes(env('ALLOW_PRIVATE_URLS', 'false').toLowerCase()),
  publicApiUrl: env('PUBLIC_API_URL', 'http://localhost:4000/v1'),
  // Endereço público do site (links nos e-mails). Por omissão, PUBLIC_API_URL sem o /v1.
  publicUrl: env('PUBLIC_URL', env('PUBLIC_API_URL', 'http://localhost:4000/v1').replace(/\/v1\/?$/, '')).replace(/\/$/, ''),
  // E-mails transacionais (verificação de e-mail) via Resend. Sem chave: em desenvolvimento o link aparece no registo.
  email: {
    resendApiKey: env('RESEND_API_KEY'),
    from: env('EMAIL_FROM', 'Losambo <no-reply@message.beeznoo.ao>'),
    verifyTtlHours: intEnv('EMAIL_VERIFY_TTL_HOURS', 24),
  },
  // Contas criadas com um e-mail (verificado) destes domínios ficam no plano Interno. Ex.: beeznoo.ao,losambo.ao
  internalEmailDomains: env('INTERNAL_EMAIL_DOMAINS')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean),
  // Entrar com WhatsApp: sessão WAHA que envia os códigos (por omissão, um número Losambo ligado).
  whatsappAuth: {
    session: env('WHATSAPP_AUTH_SESSION'),
    resendSeconds: intEnv('WHATSAPP_AUTH_RESEND_SECONDS', 60),
    maxPerPhonePerHour: intEnv('WHATSAPP_AUTH_MAX_PER_PHONE_HOUR', 5),
    maxPerIpPerHour: intEnv('WHATSAPP_AUTH_MAX_PER_IP_HOUR', 20),
  },
  // Entrar com Google (OAuth 2.0 / OpenID Connect). Sem ID e segredo, o botão fica desligado.
  google: {
    clientId: env('GOOGLE_CLIENT_ID'),
    clientSecret: env('GOOGLE_CLIENT_SECRET'),
    redirectUri: env('GOOGLE_REDIRECT_URI', `http://localhost:${env('PORT', '4000')}/auth/google/callback`),
  },
  otp: {
    ttlSeconds: intEnv('OTP_TTL_SECONDS', 300),
    maxAttempts: intEnv('OTP_MAX_ATTEMPTS', 5),
  },
  // Duração da sessão na consola (dias).
  sessionDays: intEnv('SESSION_DAYS', 14),
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
  free: {
    label: env('PLAN_FREE_LABEL', 'Grátis'),
    allowOwnNumbers: boolEnv('PLAN_FREE_ALLOW_OWN_NUMBERS', false),
    maxNumbers: limitEnv('PLAN_FREE_MAX_OWN_NUMBERS', 0),
    monthlyMessages: limitEnv('PLAN_FREE_MONTHLY_MESSAGES', 100),
  },
  startup: {
    label: env('PLAN_STARTUP_LABEL', 'Startup'),
    allowOwnNumbers: boolEnv('PLAN_STARTUP_ALLOW_OWN_NUMBERS', false),
    maxNumbers: limitEnv('PLAN_STARTUP_MAX_OWN_NUMBERS', 0),
    monthlyMessages: limitEnv('PLAN_STARTUP_MONTHLY_MESSAGES', 5000),
  },
  business: {
    label: env('PLAN_BUSINESS_LABEL', 'Negócio'),
    allowOwnNumbers: boolEnv('PLAN_BUSINESS_ALLOW_OWN_NUMBERS', true),
    maxNumbers: limitEnv('PLAN_BUSINESS_MAX_OWN_NUMBERS', null),
    monthlyMessages: limitEnv('PLAN_BUSINESS_MONTHLY_MESSAGES', null),
  },
  internal: {
    label: env('PLAN_INTERNAL_LABEL', 'Interno'),
    allowOwnNumbers: true,
    maxNumbers: null,
    monthlyMessages: null,
  },
};

/** Prefixo das sessões WAHA dos números Losambo ('_' nunca aparece nos slugs das contas). */
export const PLATFORM_SESSION_PREFIX = 'lsb_';

export const WAHA_EVENTS = ['message', 'message.ack', 'message.reaction', 'session.status', 'call.received'];
export const LOSAMBO_EVENTS = ['otp.verified', 'number.capping'];
export const ALL_EVENTS = [...WAHA_EVENTS, ...LOSAMBO_EVENTS];

export const PERMISSIONS = ['read', 'send', 'control', 'settings', 'delete'] as const;
export type Permission = (typeof PERMISSIONS)[number];
