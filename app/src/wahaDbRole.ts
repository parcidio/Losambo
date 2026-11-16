import { config } from './config.js';
import { one, query } from './db.js';

/**
 * Garante o utilizador "waha" no PostgreSQL da stack (WAHA_DB_PASSWORD definido):
 * pode entrar e criar as suas bases de sessões, mas não tem acesso à base da Losambo.
 * Corre em cada arranque — funciona em volumes novos e antigos, sem scripts montados do repositório,
 * e mantém a palavra-passe igual à de WAHA_DB_PASSWORD.
 */
export async function ensureWahaDbRole(): Promise<void> {
  const password = config.wahaDbPassword;
  if (!password) return; // fora da stack (ex.: desenvolvimento ou Supabase): nada a fazer
  const role = 'waha';
  try {
    const exists = await one('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    // CREATE/ALTER ROLE não aceitam parâmetros: o PostgreSQL monta o comando com format(%I, %L), que escapa tudo.
    const stmt = await one<{ sql: string }>(
      exists
        ? `SELECT format('ALTER ROLE %I WITH LOGIN CREATEDB PASSWORD %L', $1::text, $2::text) AS sql`
        : `SELECT format('CREATE ROLE %I WITH LOGIN CREATEDB PASSWORD %L', $1::text, $2::text) AS sql`,
      [role, password],
    );
    await query(stmt!.sql);
    const revoke = await one<{ sql: string }>(`SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database()) AS sql`);
    await query(revoke!.sql);
    console.log(`PostgreSQL: utilizador "${role}" do WAHA ${exists ? 'atualizado' : 'criado'}.`);
  } catch (err) {
    console.error(`PostgreSQL: não foi possível preparar o utilizador "${role}" do WAHA:`, (err as Error).message);
  }
}
