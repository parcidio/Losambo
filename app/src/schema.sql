CREATE TABLE IF NOT EXISTS tenants (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'free',
  plan_reason TEXT,
  plan_until DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS numbers (
  id SERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_name TEXT NOT NULL UNIQUE,
  phone TEXT,
  me_name TEXT,
  status TEXT NOT NULL DEFAULT 'STARTING',
  engine TEXT,
  worker TEXT,
  typing BOOLEAN NOT NULL DEFAULT true,
  mark_read BOOLEAN NOT NULL DEFAULT true,
  max_per_minute INT NOT NULL DEFAULT 10,
  capping_status TEXT,
  connected_since TIMESTAMPTZ,
  last_activity TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id SERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  env TEXT NOT NULL DEFAULT 'live',
  display TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  permissions TEXT[] NOT NULL,
  number_ids INT[],
  active BOOLEAN NOT NULL DEFAULT true,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  tenant_id INT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  events TEXT[] NOT NULL,
  secret TEXT NOT NULL,
  retry_policy TEXT NOT NULL DEFAULT 'exponential',
  attempts INT NOT NULL DEFAULT 15,
  delay_seconds INT NOT NULL DEFAULT 2,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS otps (
  id TEXT PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number_id INT REFERENCES numbers(id) ON DELETE SET NULL,
  phone TEXT,
  app TEXT,
  mode TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  verified_from TEXT,
  error TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otps_reverse_idx ON otps (code_hash) WHERE mode = 'reverse';

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number_id INT REFERENCES numbers(id) ON DELETE SET NULL,
  direction TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  body TEXT,
  waha_id TEXT,
  ack TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_tenant_idx ON messages (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number_id INT REFERENCES numbers(id) ON DELETE SET NULL,
  session_name TEXT,
  event TEXT NOT NULL,
  payload JSONB NOT NULL,
  delivery TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_tenant_idx ON events (tenant_id, id DESC);

-- Subscrição: a API e os envios só funcionam com a subscrição ativa.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'inactive';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_ends_at TIMESTAMPTZ;

-- Números: 'platform' = número Losambo (sem dono, partilhado por várias contas);
-- 'customer' = número próprio do cliente (só nos planos que o permitem).
ALTER TABLE numbers ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE numbers ADD COLUMN IF NOT EXISTS ownership TEXT NOT NULL DEFAULT 'customer';
ALTER TABLE numbers ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE numbers DROP COLUMN IF EXISTS waha_key_id;
ALTER TABLE numbers DROP COLUMN IF EXISTS waha_key_enc;
ALTER TABLE numbers DROP COLUMN IF EXISTS waha_key_active;

-- Que contas podem usar que número, cada uma com a sua chave WAHA própria (cifrada, AES-256-GCM).
CREATE TABLE IF NOT EXISTS number_assignments (
  number_id INT NOT NULL REFERENCES numbers(id) ON DELETE CASCADE,
  tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  waha_key_id TEXT,
  waha_key_enc TEXT,
  waha_key_active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (number_id, tenant_id)
);
CREATE INDEX IF NOT EXISTS number_assignments_tenant_idx ON number_assignments (tenant_id);
-- Entrar com Google: contas só-Google não têm palavra-passe.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT UNIQUE;

CREATE INDEX IF NOT EXISTS messages_route_idx ON messages (number_id, chat_id, created_at DESC);

-- Entrar / criar conta com WhatsApp
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT UNIQUE;
CREATE TABLE IF NOT EXISTS auth_codes (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  purpose TEXT NOT NULL,
  payload JSONB,
  code_hash TEXT NOT NULL,
  number_id INT REFERENCES numbers(id) ON DELETE SET NULL,
  ip TEXT,
  attempts INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_codes_phone_idx ON auth_codes (phone, created_at);

-- Verificação de e-mail (Resend). As contas que já existiam ficam verificadas uma única vez.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'email_verified_at') THEN
    ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;
    UPDATE users SET email_verified_at = now() WHERE email IS NOT NULL;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_tokens_user_idx ON email_tokens (user_id, created_at DESC);

-- Recuperar palavra-passe: os links de e-mail têm uma finalidade ('verify' ou 'reset').
ALTER TABLE email_tokens ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'verify';
