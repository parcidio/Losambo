import { one, query } from '../db.js';
import { ApiError } from '../http.js';
import { purgeUnverifiedSignups } from './accounts.js';
import { syncTenantKeys } from './numbers.js';
import type { Tenant } from './tenants.js';

export type SubscriptionStatus = 'inactive' | 'active' | 'expired' | 'canceled';

/** Muda a subscrição e liga/desliga logo as chaves WAHA da conta. */
export async function setSubscription(tenantId: number, status: SubscriptionStatus, endsAt: string | null) {
  const t = await one<Tenant>(
    'UPDATE tenants SET subscription_status = $2, subscription_ends_at = $3 WHERE id = $1 RETURNING *',
    [tenantId, status, endsAt],
  );
  if (!t) throw new ApiError(404, 'tenant_not_found');
  const sync = await syncTenantKeys(tenantId);
  return { tenant: t, keys: sync };
}

/** Marca como expiradas as subscrições cujo período acabou e desliga as respetivas chaves. */
export async function expireSubscriptions(): Promise<void> {
  const expired = await query<{ id: number }>(
    `UPDATE tenants SET subscription_status = 'expired'
     WHERE subscription_status = 'active' AND subscription_ends_at IS NOT NULL AND subscription_ends_at <= now()
     RETURNING id`,
  );
  for (const { id } of expired) {
    const r = await syncTenantKeys(id);
    if (r.errors.length) console.error(`Subscrição ${id} expirou; falha a desligar chaves:`, r.errors);
  }
}

export function startSubscriptionSweeper(): void {
  const run = () => {
    void expireSubscriptions().catch((err) => console.error('expireSubscriptions', err));
    void purgeUnverifiedSignups().catch((err) => console.error('purgeUnverifiedSignups', err));
  };
  run();
  setInterval(run, 5 * 60 * 1000).unref();
}
