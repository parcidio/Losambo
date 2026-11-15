import { config } from '../config.js';
import { one, pool, query } from '../db.js';
import { assignDefaultNumbers, syncTenantKeys } from './numbers.js';
import { getTenant, uniqueSlug } from './tenants.js';

export function isInternalEmail(email: string | null | undefined): boolean {
  const domain = email?.toLowerCase().split('@')[1];
  return !!domain && config.internalEmailDomains.includes(domain);
}

/**
 * Cria a conta (empresa) e o seu primeiro utilizador. O primeiro utilizador da plataforma fica super-admin.
 * Contas com e-mail por verificar ficam "em espera": sem número nem plano Interno até o e-mail ser confirmado
 * (ver onEmailVerified). Contas já verificadas (Google, WhatsApp) ficam prontas logo.
 */
export async function createAccount(input: {
  name: string;
  company: string;
  email: string | null;
  phone?: string | null;
  passwordHash: string | null;
  googleSub?: string | null;
  emailVerified: boolean;
}): Promise<{ userId: number; tenantId: number }> {
  const client = await pool.connect();
  let ids: { userId: number; tenantId: number };
  try {
    await client.query('BEGIN');
    const slug = await uniqueSlug(input.company);
    const t = await client.query('INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id', [input.company, slug]);
    const first = await client.query('SELECT count(*)::int AS c FROM users');
    const u = await client.query(
      `INSERT INTO users (tenant_id, name, email, phone, password_hash, google_sub, is_admin, email_verified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $8 THEN now() END) RETURNING id`,
      [
        t.rows[0].id,
        input.name,
        input.email?.toLowerCase() ?? null,
        input.phone ?? null,
        input.passwordHash,
        input.googleSub ?? null,
        first.rows[0].c === 0,
        input.emailVerified,
      ],
    );
    await client.query('COMMIT');
    ids = { userId: u.rows[0].id, tenantId: t.rows[0].id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  if (input.emailVerified || !input.email) await onEmailVerified(ids.userId);
  return ids;
}

/**
 * A conta fica pronta: plano Interno se o e-mail (verificado) for de um domínio interno,
 * e um número Losambo livre se ainda não tiver nenhum.
 */
export async function onEmailVerified(userId: number): Promise<void> {
  const u = await one<{ tenant_id: number; email: string | null; email_verified_at: string | null }>(
    'SELECT tenant_id, email, email_verified_at FROM users WHERE id = $1',
    [userId],
  );
  if (!u) return;
  if (u.email && u.email_verified_at && isInternalEmail(u.email)) {
    const changed = await one(
      `UPDATE tenants SET plan = 'internal', plan_reason = $2, plan_until = NULL
       WHERE id = $1 AND plan <> 'internal' RETURNING id`,
      [u.tenant_id, `Domínio interno (${u.email.split('@')[1]})`],
    );
    if (changed) await syncTenantKeys(u.tenant_id).catch(() => undefined);
  }
  const has = await one('SELECT 1 FROM number_assignments WHERE tenant_id = $1', [u.tenant_id]);
  if (has) return;
  // Falhas na criação da chave ficam registadas; o admin repete em "Criar / sincronizar chaves".
  try {
    await assignDefaultNumbers(await getTenant(u.tenant_id));
  } catch (err) {
    console.error('Atribuição de número falhou (o admin pode repetir):', (err as Error).message);
  }
}

/** Utilizadores com e-mail por verificar e contas sem nada há mais de 7 dias: limpeza das inscrições abandonadas. */
export async function purgeUnverifiedSignups(): Promise<void> {
  await query(
    `DELETE FROM tenants t WHERE t.created_at < now() - interval '7 days'
       AND EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = t.id AND (u.email_verified_at IS NOT NULL OR u.email IS NULL))`,
  );
}
