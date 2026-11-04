import { pool } from '../db.js';
import { assignDefaultNumbers } from './numbers.js';
import { getTenant, uniqueSlug } from './tenants.js';

/**
 * Cria a conta (empresa) e o seu primeiro utilizador. O primeiro utilizador da plataforma fica super-admin.
 * Depois atribui os números Losambo por omissão, com uma chave WAHA própria para cada.
 */
export async function createAccount(input: {
  name: string;
  company: string;
  email: string;
  passwordHash: string | null;
  googleSub?: string | null;
}): Promise<{ userId: number; tenantId: number }> {
  const client = await pool.connect();
  let ids: { userId: number; tenantId: number };
  try {
    await client.query('BEGIN');
    const slug = await uniqueSlug(input.company);
    const t = await client.query('INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id', [input.company, slug]);
    const first = await client.query('SELECT count(*)::int AS c FROM users');
    const u = await client.query(
      `INSERT INTO users (tenant_id, name, email, password_hash, google_sub, is_admin) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [t.rows[0].id, input.name, input.email.toLowerCase(), input.passwordHash, input.googleSub ?? null, first.rows[0].c === 0],
    );
    await client.query('COMMIT');
    ids = { userId: u.rows[0].id, tenantId: t.rows[0].id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  // Falhas na criação da chave ficam registadas; o admin repete em "Criar / sincronizar chaves".
  try {
    await assignDefaultNumbers(await getTenant(ids.tenantId));
  } catch (err) {
    console.error('Atribuição de números no registo falhou (o admin pode repetir):', (err as Error).message);
  }
  return ids;
}
