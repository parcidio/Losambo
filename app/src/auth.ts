import type { NextFunction, Request, Response } from 'express';
import { config, type Permission } from './config.js';
import { one, query } from './db.js';
import { ApiError, asyncHandler } from './http.js';
import { sha256, token } from './security.js';

export interface SessionUser {
  id: number;
  tenant_id: number;
  name: string;
  email: string | null;
  phone: string | null;
  is_admin: boolean;
}

export interface ApiKeyCtx {
  id: number;
  tenant_id: number;
  permissions: Permission[];
  number_ids: number[] | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
      apiKey?: ApiKeyCtx;
    }
  }
}

export const COOKIE = 'lsb_session';
const SESSION_DAYS = 14;

export async function startSession(res: Response, userId: number): Promise<void> {
  const t = token(32);
  await query(`INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`, [
    sha256(t),
    userId,
  ]);
  res.cookie(COOKIE, t, { httpOnly: true, secure: config.secureCookies, sameSite: 'lax', maxAge: SESSION_DAYS * 86400_000, path: '/' });
}

export async function endSession(req: Request, res: Response): Promise<void> {
  const t = req.cookies?.[COOKIE];
  if (t) await query('DELETE FROM user_sessions WHERE token_hash = $1', [sha256(t)]);
  res.clearCookie(COOKIE, { path: '/' });
}

export const requireUser = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const t = req.cookies?.[COOKIE];
  if (!t) throw new ApiError(401, 'unauthenticated', 'Sessão expirada. Entre novamente.');
  const user = await one<SessionUser>(
    `SELECT u.id, u.tenant_id, u.name, u.email, u.phone, u.is_admin FROM user_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(t)],
  );
  if (!user) throw new ApiError(401, 'unauthenticated', 'Sessão expirada. Entre novamente.');
  req.user = user;
  next();
});

export const requireAdmin = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.user?.is_admin) return next(new ApiError(403, 'forbidden', 'Só para super-admin.'));
  next();
};

export const requireApiKey = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.header('authorization') ?? '';
  const m = header.match(/^Bearer\s+(lsb_(?:live|test)_[A-Za-z0-9_-]+)$/);
  if (!m) throw new ApiError(401, 'unauthenticated', 'Use Authorization: Bearer lsb_live_…');
  const key = await one<ApiKeyCtx>(
    'UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1 AND active RETURNING id, tenant_id, permissions, number_ids',
    [sha256(m[1])],
  );
  if (!key) throw new ApiError(401, 'invalid_api_key', 'Chave API inválida ou desativada.');
  req.apiKey = key;
  next();
});

export function can(perm: Permission) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.apiKey?.permissions.includes(perm)) {
      return next(new ApiError(403, 'missing_permission', `A chave não tem a permissão "${perm}".`));
    }
    next();
  };
}
