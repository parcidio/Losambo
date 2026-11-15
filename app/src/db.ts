import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { config } from './config.js';

// SSL: DATABASE_SSL=true para bases geridas (Supabase…), false para o PostgreSQL da stack; vazio = sslmode do URL.
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.databasePoolMax,
  ssl: config.databaseSsl === undefined ? undefined : config.databaseSsl ? { rejectUnauthorized: false } : false,
});

export async function query<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query<T>(text, params);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function migrate(): Promise<void> {
  const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}
