import { PLATFORM_SESSION_PREFIX } from '../config.js';
import { one, query } from '../db.js';
import { ApiError } from '../http.js';
import { decrypt, encrypt } from '../security.js';
import {
  wahaAdmin,
  wahaWithKey,
  WahaError,
  type Capping,
  type KeyScope,
  type Timelock,
  type WahaClient,
  type WahaSession,
} from '../waha.js';
import {
  allowsOwnNumbers,
  assertAllowsOwnNumbers,
  assertCanAddNumber,
  assertSubscriptionActive,
  getTenant,
  subscriptionActive,
  type Tenant,
} from './tenants.js';

export interface NumberRow {
  id: number;
  tenant_id: number | null;
  ownership: 'platform' | 'customer';
  is_default: boolean;
  session_name: string;
  phone: string | null;
  me_name: string | null;
  status: string;
  engine: string | null;
  worker: string | null;
  typing: boolean;
  mark_read: boolean;
  max_per_minute: number;
  capping_status: string | null;
  connected_since: string | null;
  last_activity: string | null;
  created_at: string;
}

/** Um número visto por uma conta: inclui a chave WAHA dessa conta para esse número. */
export interface TenantNumber extends NumberRow {
  account_id: number;
  waha_key_id: string | null;
  waha_key_enc: string | null;
  waha_key_active: boolean;
}

const TENANT_NUMBER_SQL = `SELECT n.*, a.tenant_id AS account_id, a.waha_key_id, a.waha_key_enc, a.waha_key_active
  FROM number_assignments a JOIN numbers n ON n.id = a.number_id`;

export async function listNumbers(tenantId: number): Promise<TenantNumber[]> {
  return query<TenantNumber>(`${TENANT_NUMBER_SQL} WHERE a.tenant_id = $1 ORDER BY n.ownership, n.id`, [tenantId]);
}

export async function getNumber(tenantId: number, id: number | string): Promise<TenantNumber> {
  const n = await one<TenantNumber>(`${TENANT_NUMBER_SQL} WHERE a.tenant_id = $1 AND (n.id::text = $2 OR n.session_name = $2)`, [
    tenantId,
    String(id),
  ]);
  if (!n) throw new ApiError(404, 'number_not_found', 'Número não encontrado');
  return n;
}

export async function getNumberRow(id: number | string): Promise<NumberRow> {
  const n = await one<NumberRow>('SELECT * FROM numbers WHERE id::text = $1 OR session_name = $1', [String(id)]);
  if (!n) throw new ApiError(404, 'number_not_found', 'Número não encontrado');
  return n;
}

export async function findBySession(session: string): Promise<NumberRow | null> {
  return one<NumberRow>('SELECT * FROM numbers WHERE session_name = $1', [session]);
}

export async function tenantsOf(numberId: number): Promise<number[]> {
  const rows = await query<{ tenant_id: number }>('SELECT tenant_id FROM number_assignments WHERE number_id = $1', [numberId]);
  return rows.map((r) => r.tenant_id);
}

/** A conta pode usar este número agora? Números próprios exigem um plano que os permita. */
export function usable(t: Tenant, n: NumberRow): boolean {
  return n.ownership === 'platform' || allowsOwnNumbers(t);
}

/** Uma chave deve estar ligada quando a subscrição está ativa e o plano permite o número. */
function keyShouldBeActive(t: Tenant, n: NumberRow): boolean {
  return subscriptionActive(t) && usable(t, n);
}

export function assertCustomerNumber(n: NumberRow): void {
  if (n.ownership !== 'customer') {
    throw new ApiError(403, 'platform_number', 'Este é um número Losambo partilhado; é gerido pela equipa Losambo.');
  }
}

/** Garante a chave WAHA desta conta para este número (criada com a chave admin) e devolve-a. */
async function ensureKey(n: TenantNumber, active: boolean): Promise<string> {
  if (n.waha_key_enc) return decrypt(n.waha_key_enc);
  const key = await wahaAdmin.createKey(n.session_name, n.ownership as KeyScope, active);
  const enc = encrypt(key.key);
  await query(
    'UPDATE number_assignments SET waha_key_id = $3, waha_key_enc = $4, waha_key_active = $5 WHERE number_id = $1 AND tenant_id = $2',
    [n.id, n.account_id, key.id, enc, key.isActive],
  );
  n.waha_key_id = key.id;
  n.waha_key_enc = enc;
  n.waha_key_active = key.isActive;
  return key.key;
}

/**
 * Cliente WAHA com a chave da conta para este número. Exige subscrição ativa e um plano
 * que permita o número: sem isso a chave WAHA está desligada e o pedido nem sai da Losambo.
 */
export async function clientFor(n: TenantNumber, tenant?: Tenant): Promise<WahaClient> {
  const t = await assertSubscriptionActive(tenant ?? n.account_id);
  if (!usable(t, n)) assertAllowsOwnNumbers(t);
  return wahaWithKey(await ensureKey(n, true));
}

async function assign(tenant: Tenant, n: NumberRow): Promise<TenantNumber> {
  await query('INSERT INTO number_assignments (number_id, tenant_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [n.id, tenant.id]);
  const tn = await getNumber(tenant.id, n.id);
  try {
    await ensureKey(tn, keyShouldBeActive(tenant, n));
  } catch (err) {
    console.error(`Falha ao criar a chave WAHA de ${tenant.slug} para ${n.session_name}:`, (err as Error).message);
  }
  return tn;
}

async function unassign(tenantId: number, numberId: number): Promise<void> {
  const a = await one<{ waha_key_id: string | null }>(
    'DELETE FROM number_assignments WHERE number_id = $1 AND tenant_id = $2 RETURNING waha_key_id',
    [numberId, tenantId],
  );
  if (a?.waha_key_id) await wahaAdmin.deleteKey(a.waha_key_id).catch(() => undefined);
}

/** Dá a uma conta nova os números Losambo marcados como "por omissão" (cria a chave WAHA dela). */
export async function assignDefaultNumbers(tenant: Tenant): Promise<number> {
  const defaults = await query<NumberRow>(`SELECT * FROM numbers WHERE ownership = 'platform' AND is_default ORDER BY id`);
  for (const n of defaults) await assign(tenant, n);
  return defaults.length;
}

/** Define exatamente que números Losambo a conta pode usar. */
export async function setPlatformAssignments(tenantId: number, numberIds: number[]): Promise<TenantNumber[]> {
  const tenant = await getTenant(tenantId);
  const wanted = new Set(numberIds);
  const current = (await listNumbers(tenantId)).filter((n) => n.ownership === 'platform');
  for (const n of current) if (!wanted.has(n.id)) await unassign(tenantId, n.id);
  for (const id of wanted) {
    const n = await getNumberRow(id);
    if (n.ownership !== 'platform') throw new ApiError(400, 'not_platform_number', `${n.session_name} não é um número Losambo.`);
    await assign(tenant, n);
  }
  return listNumbers(tenantId);
}

async function nextSessionName(prefix: string): Promise<string> {
  const like = prefix.replace(/[_%]/g, (c) => `\\${c}`);
  const [{ max }] = await query<{ max: number | null }>(
    `SELECT max(substring(session_name from '(\\d+)$')::int) AS max FROM numbers WHERE session_name LIKE $1`,
    [`${like}%`],
  );
  return `${prefix}${String((max ?? 0) + 1).padStart(2, '0')}`;
}

/** Admin: cria um número Losambo (sessão WAHA sem dono) e inicia-o para mostrar o QR. */
export async function createPlatformNumber(): Promise<NumberRow> {
  const name = await nextSessionName(PLATFORM_SESSION_PREFIX);
  const session = await wahaAdmin.createSession(name, true);
  return (await one<NumberRow>(
    `INSERT INTO numbers (tenant_id, ownership, session_name, status) VALUES (NULL, 'platform', $1, $2) RETURNING *`,
    [name, session.status ?? 'STARTING'],
  ))!;
}

export async function listPlatformNumbers(): Promise<(NumberRow & { accounts: number })[]> {
  await listAllLive().catch(() => undefined);
  return query(
    `SELECT n.*, (SELECT count(*)::int FROM number_assignments a WHERE a.number_id = n.id) AS accounts
     FROM numbers n WHERE n.ownership = 'platform' ORDER BY n.id`,
  );
}

function phoneFromMe(me: WahaSession['me']): string | null {
  const id = me?.id;
  if (!id) return null;
  const digits = id.split('@')[0].split(':')[0];
  return digits ? `+${digits}` : null;
}

/** Atualiza a cópia local com o estado vindo do WAHA (mantém os campos da conta). */
export async function applySession<T extends NumberRow>(n: T, s: WahaSession): Promise<T> {
  const wasWorking = n.status === 'WORKING';
  const working = s.status === 'WORKING';
  const activity = s.timestamps?.activity ? new Date(s.timestamps.activity) : null;
  const updated = await one<NumberRow>(
    `UPDATE numbers SET status = $2, engine = COALESCE($3, engine), worker = COALESCE($4, worker),
       phone = COALESCE($5, phone), me_name = COALESCE($6, me_name),
       connected_since = CASE WHEN $7 THEN COALESCE(connected_since, now()) WHEN $8 THEN connected_since ELSE NULL END,
       last_activity = COALESCE($9, last_activity)
     WHERE id = $1 RETURNING *`,
    [
      n.id,
      s.status,
      s.engine?.engine ?? null,
      s.assignedWorker ?? null,
      phoneFromMe(s.me),
      s.me?.pushName ?? null,
      working && !wasWorking,
      working,
      activity,
    ],
  );
  return { ...n, ...(updated ?? {}) };
}

// Leituras de estado usam a chave admin: continuam visíveis com a subscrição inativa.
export async function refreshNumber<T extends NumberRow>(n: T): Promise<T> {
  try {
    return await applySession(n, await wahaAdmin.getSession(n.session_name));
  } catch (err) {
    if (err instanceof WahaError && err.status === 404) {
      await query(`UPDATE numbers SET status = 'STOPPED' WHERE id = $1`, [n.id]);
      return { ...n, status: 'STOPPED' };
    }
    throw err;
  }
}

async function liveMerge<T extends NumberRow>(rows: T[]): Promise<T[]> {
  let sessions: WahaSession[];
  try {
    sessions = await wahaAdmin.listSessions();
  } catch {
    return rows; // WAHA em baixo: mostra o último estado conhecido
  }
  const byName = new Map(sessions.map((s) => [s.name, s]));
  return Promise.all(
    rows.map(async (n) => {
      const s = byName.get(n.session_name);
      if (s) return applySession(n, s);
      await query(`UPDATE numbers SET status = 'STOPPED' WHERE id = $1`, [n.id]);
      return { ...n, status: 'STOPPED' };
    }),
  );
}

export async function listNumbersLive(tenantId: number): Promise<TenantNumber[]> {
  return liveMerge(await listNumbers(tenantId));
}

async function listAllLive(): Promise<NumberRow[]> {
  return liveMerge(await query<NumberRow>('SELECT * FROM numbers ORDER BY id'));
}

/**
 * "Ligar número" (só planos com números próprios): reutiliza um número próprio ainda por associar,
 * senão cria outro dentro do limite do plano; depois inicia-o para mostrar o QR.
 */
export async function createNumber(tenantId: number): Promise<TenantNumber> {
  const tenant = await assertSubscriptionActive(tenantId);
  assertAllowsOwnNumbers(tenant);
  let n = (await listNumbers(tenantId)).find((x) => x.ownership === 'customer' && !x.phone && x.status !== 'WORKING');
  if (!n) {
    await assertCanAddNumber(tenant);
    const name = await nextSessionName(`${tenant.slug}-`);
    const session = await wahaAdmin.createSession(name, false);
    const row = (await one<NumberRow>(
      `INSERT INTO numbers (tenant_id, ownership, session_name, status) VALUES ($1, 'customer', $2, $3) RETURNING *`,
      [tenant.id, name, session.status ?? 'STOPPED'],
    ))!;
    n = await assign(tenant, row);
  }
  const client = await clientFor(n, tenant);
  try {
    await client.start(n.session_name);
  } catch (err) {
    if (!(err instanceof WahaError && err.status === 422)) throw err; // já iniciada
  }
  return refreshNumber(n);
}

export async function health(n: TenantNumber): Promise<{
  number: TenantNumber;
  capping: Capping | null;
  timelock: Timelock | null;
  errors: string[];
}> {
  const number = await refreshNumber(n);
  const errors: string[] = [];
  let capping: Capping | null = null;
  let timelock: Timelock | null = null;
  if (number.status === 'WORKING') {
    let client: WahaClient | null = null;
    try {
      client = await clientFor(number);
    } catch (err) {
      errors.push((err as Error).message);
    }
    if (client) {
      const [c, t] = await Promise.allSettled([client.capping(number.session_name), client.timelock(number.session_name)]);
      if (c.status === 'fulfilled') capping = c.value;
      else errors.push(`capping: ${(c.reason as Error).message}`);
      if (t.status === 'fulfilled') timelock = t.value;
      else errors.push(`timelock: ${(t.reason as Error).message}`);
    }
    if (capping && capping.cappingStatus !== number.capping_status) {
      await query('UPDATE numbers SET capping_status = $2 WHERE id = $1', [number.id, capping.cappingStatus]);
      number.capping_status = capping.cappingStatus;
    }
  }
  return { number, capping, timelock, errors };
}

type Action = 'start' | 'stop' | 'restart' | 'logout';

/** Conta: só controla os seus números próprios, com a sua chave. */
export async function control(n: TenantNumber, action: Action): Promise<TenantNumber> {
  assertCustomerNumber(n);
  await (await clientFor(n))[action](n.session_name);
  return refreshNumber(n);
}

/** Admin: controla qualquer número com a chave admin. */
export async function adminControl(n: NumberRow, action: Action): Promise<NumberRow> {
  await wahaAdmin[action](n.session_name);
  return refreshNumber(n);
}

/** Apaga o número no WAHA e todas as chaves das contas que o usavam. */
export async function deleteNumber(n: NumberRow): Promise<void> {
  const keys = await query<{ waha_key_id: string | null }>('SELECT waha_key_id FROM number_assignments WHERE number_id = $1', [n.id]);
  for (const k of keys) if (k.waha_key_id) await wahaAdmin.deleteKey(k.waha_key_id).catch(() => undefined);
  try {
    await wahaAdmin.logout(n.session_name);
  } catch {
    // pode já estar desligado
  }
  try {
    await wahaAdmin.remove(n.session_name);
  } catch (err) {
    if (!(err instanceof WahaError && err.status === 404)) throw err;
  }
  await query('DELETE FROM numbers WHERE id = $1', [n.id]);
}

/** Liga ou desliga no WAHA as chaves da conta conforme a subscrição e o plano. */
export async function syncTenantKeys(tenantId: number): Promise<{ updated: number; errors: string[] }> {
  const tenant = await getTenant(tenantId);
  const errors: string[] = [];
  let updated = 0;
  for (const n of await listNumbers(tenantId)) {
    const active = keyShouldBeActive(tenant, n);
    try {
      if (!n.waha_key_id) {
        await ensureKey(n, active);
        updated++;
        continue;
      }
      if (n.waha_key_active === active) continue;
      await wahaAdmin.setKeyActive(n.waha_key_id, n.session_name, n.ownership as KeyScope, active);
      await query('UPDATE number_assignments SET waha_key_active = $3 WHERE number_id = $1 AND tenant_id = $2', [
        n.id,
        tenantId,
        active,
      ]);
      updated++;
    } catch (err) {
      errors.push(`${n.session_name}: ${(err as Error).message}`);
    }
  }
  return { updated, errors };
}

export async function updateSettings(
  n: NumberRow,
  s: { typing?: boolean; mark_read?: boolean; max_per_minute?: number; is_default?: boolean },
): Promise<NumberRow> {
  const row = await one<NumberRow>(
    `UPDATE numbers SET typing = COALESCE($2, typing), mark_read = COALESCE($3, mark_read),
       max_per_minute = COALESCE($4, max_per_minute), is_default = COALESCE($5, is_default) WHERE id = $1 RETURNING *`,
    [n.id, s.typing ?? null, s.mark_read ?? null, s.max_per_minute ?? null, s.is_default ?? null],
  );
  return row!;
}
