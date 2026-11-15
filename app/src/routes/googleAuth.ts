import { createHash } from 'node:crypto';
import { Router, type Response } from 'express';
import { startSession } from '../auth.js';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { asyncHandler } from '../http.js';
import { token } from '../security.js';
import { createAccount } from '../services/accounts.js';

/** Entrar / criar conta com Google (OAuth 2.0 + OpenID Connect, fluxo "authorization code" com PKCE). */
export const googleAuth = Router();

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const COOKIE = 'lsb_oauth';

export function googleEnabled(): boolean {
  return !!config.google.clientId && !!config.google.clientSecret;
}

function fail(res: Response, code: string): void {
  res.clearCookie(COOKIE, { path: '/auth/google' });
  res.redirect(`/entrar?erro=${encodeURIComponent(code)}`);
}

googleAuth.get('/auth/google', (_req, res) => {
  if (!googleEnabled()) return fail(res, 'google_desligado');
  const state = token(24);
  const verifier = token(48);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  res.cookie(COOKIE, JSON.stringify({ state: state, verifier: verifier }), {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000,
    path: '/auth/google',
  });
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: config.google.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  res.redirect(`${AUTH_URL}?${params}`);
});

googleAuth.get(
  '/auth/google/callback',
  asyncHandler(async (req, res) => {
    if (!googleEnabled()) return fail(res, 'google_desligado');
    if (req.query.error) return fail(res, 'google_cancelado');
    let saved: { state?: string; verifier?: string } = {};
    try {
      saved = JSON.parse(req.cookies?.[COOKIE] ?? '{}');
    } catch {
      // cookie inválido
    }
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code || !saved.state || !saved.verifier || req.query.state !== saved.state) return fail(res, 'google_estado');

    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code,
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        redirect_uri: config.google.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: saved.verifier,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!tokenRes.ok) {
      console.error('Google token', tokenRes.status, await tokenRes.text());
      return fail(res, 'google_token');
    }
    const { access_token: accessToken } = (await tokenRes.json()) as { access_token?: string };
    const infoRes = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!infoRes.ok) return fail(res, 'google_perfil');
    const info = (await infoRes.json()) as { sub?: string; email?: string; email_verified?: boolean; name?: string };
    if (!info.sub || !info.email || !info.email_verified) return fail(res, 'google_email');

    const email = info.email.toLowerCase();
    let user = await one<{ id: number }>('SELECT id FROM users WHERE google_sub = $1', [info.sub]);
    if (!user) {
      // Mesmo e-mail numa conta sem palavra-passe → liga o Google a essa conta.
      // Contas com palavra-passe não são ligadas: o e-mail delas nunca foi verificado, e quem a criou
      // (talvez outra pessoa, com o e-mail da vítima) continuaria a entrar com a palavra-passe.
      user = await one<{ id: number }>(
        'UPDATE users SET google_sub = $2 WHERE email = $1 AND google_sub IS NULL AND password_hash IS NULL RETURNING id',
        [email, info.sub],
      );
    }
    if (!user) {
      if (await one('SELECT 1 FROM users WHERE email = $1', [email])) return fail(res, 'google_conflito');
      const name = info.name?.trim() || email.split('@')[0];
      const { userId } = await createAccount({ name: name, company: name, email: email, passwordHash: null, googleSub: info.sub });
      user = { id: userId };
    }
    await query('DELETE FROM user_sessions WHERE expires_at < now()');
    res.clearCookie(COOKIE, { path: '/auth/google' });
    await startSession(res, user.id);
    res.redirect('/consola');
  }),
);
