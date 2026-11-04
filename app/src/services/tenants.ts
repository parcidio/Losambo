import { plans, type PlanId } from '../config.js';
import { one, query } from '../db.js';
import { ApiError } from '../http.js';

export interface Tenant {
  id: number;
  name: string;
  slug: string;
  plan: PlanId;
  plan_reason: string | null;
  plan_until: string | null;
  subscription_status: 'inactive' | 'active' | 'expired' | 'canceled';
  subscription_ends_at: string | null;
}

/** O plano Interno não é cobrado, por isso conta sempre como subscrição ativa. */
export function subscriptionActive(t: Tenant): boolean {
  if (effectivePlan(t) === 'internal') return true;
  if (t.subscription_status !== 'active') return false;
  return !t.subscription_ends_at || new Date(t.subscription_ends_at) > new Date();
}

export async function assertSubscriptionActive(tenantOrId: Tenant | number): Promise<Tenant> {
  const t = typeof tenantOrId === 'number' ? await getTenant(tenantOrId) : tenantOrId;
  if (!subscriptionActive(t)) {
    throw new ApiError(
      402,
      'subscription_inactive',
      'A subscrição desta conta não está ativa. A API e os envios ficam desativados até ser ativada.',
    );
  }
  return t;
}

export function slugify(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return base || 'conta';
}

export async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  let slug = base;
  for (let i = 2; await one('SELECT 1 FROM tenants WHERE slug = $1', [slug]); i++) slug = `${base}${i}`;
  return slug;
}

export async function getTenant(id: number): Promise<Tenant> {
  const t = await one<Tenant>('SELECT * FROM tenants WHERE id = $1', [id]);
  if (!t) throw new ApiError(404, 'tenant_not_found');
  return t;
}

/** Plano efetivo: um plano Interno expirado volta a Grátis. */
export function effectivePlan(t: Tenant): PlanId {
  if (t.plan === 'internal' && t.plan_until && new Date(t.plan_until) < new Date()) return 'free';
  return t.plan;
}

export function allowsOwnNumbers(t: Tenant): boolean {
  return plans[effectivePlan(t)].allowOwnNumbers;
}

export function assertAllowsOwnNumbers(t: Tenant): void {
  if (!allowsOwnNumbers(t)) {
    throw new ApiError(
      402,
      'own_numbers_not_in_plan',
      `Ligar o seu próprio número está disponível no plano Negócio. No plano ${plans[effectivePlan(t)].label} usa os números Losambo atribuídos à conta.`,
    );
  }
}

export async function assertCanAddNumber(t: Tenant): Promise<void> {
  assertAllowsOwnNumbers(t);
  const limit = plans[effectivePlan(t)].maxNumbers;
  if (limit == null) return;
  const [{ count }] = await query<{ count: string }>(
    `SELECT count(*) FROM numbers WHERE tenant_id = $1 AND ownership = 'customer'`,
    [t.id],
  );
  if (Number(count) >= limit) {
    throw new ApiError(402, 'plan_limit', `O plano ${plans[effectivePlan(t)].label} permite ${limit} número(s).`);
  }
}

export async function assertCanSendMessage(t: Tenant): Promise<void> {
  const limit = plans[effectivePlan(t)].monthlyMessages;
  if (limit == null) return;
  const [{ count }] = await query<{ count: string }>(
    `SELECT count(*) FROM messages WHERE tenant_id = $1 AND direction = 'out' AND created_at >= date_trunc('month', now())`,
    [t.id],
  );
  if (Number(count) >= limit) throw new ApiError(402, 'plan_limit', `Limite mensal de ${limit} mensagens atingido.`);
}
