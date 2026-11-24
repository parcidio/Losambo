import { z } from 'zod';
import { clientFor } from './numbers.js';
import { pickNumber } from './messaging.js';

/** Parâmetros de GET /v1/contacts e da página Contactos da consola. */
export const contactsQuery = z.object({
  via: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  sort_by: z.enum(['name', 'id']).optional(),
  sort_order: z.enum(['asc', 'desc']).optional(),
});
export type ContactsQuery = z.output<typeof contactsQuery>;

/** Contactos WhatsApp de um número da conta (WAHA GET /api/contacts/all), com a chave WAHA da conta. */
export async function listContacts(tenantId: number, q: ContactsQuery, allowed?: number[] | null) {
  const n = await pickNumber(tenantId, q.via ?? null, allowed);
  const rows = await (await clientFor(n)).contactsAll(n.session_name, {
    limit: q.limit,
    offset: q.offset,
    sortBy: q.sort_by,
    sortOrder: q.sort_order,
  });
  return {
    via: n.session_name,
    limit: q.limit,
    offset: q.offset,
    count: rows.length,
    data: rows.map((c) => ({
      id: c.id,
      phone: c.number ?? (c.id?.endsWith('@c.us') ? c.id.split('@')[0] : null),
      name: c.name ?? null,
      push_name: c.pushname ?? null,
      short_name: c.shortName ?? null,
      is_my_contact: c.isMyContact ?? null,
      is_business: c.isBusiness ?? null,
      is_group: c.isGroup ?? c.id?.endsWith('@g.us') ?? null,
      is_blocked: c.isBlocked ?? null,
    })),
  };
}
