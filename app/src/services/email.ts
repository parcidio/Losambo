import { createElement, type ReactElement } from 'react';
import { render } from 'react-email';
import { Resend } from 'resend';
import VerifyEmail from '../emails/verify-email.js';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { ApiError } from '../http.js';
import { sha256, token } from '../security.js';

let client: Resend | null = null;
function resend(): Resend {
  client ??= new Resend(config.email.resendApiKey);
  return client;
}

/**
 * Envia um e-mail (modelo React Email) pelo Resend. O SDK gera o HTML e o texto simples.
 * Sem RESEND_API_KEY: em produção falha; em desenvolvimento escreve a versão em texto no registo.
 */
export async function sendEmail(msg: { to: string; subject: string; react: ReactElement }): Promise<void> {
  if (!config.email.resendApiKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new ApiError(503, 'email_unavailable', 'O envio de e-mails não está configurado. Tente mais tarde.');
    }
    console.log(`[e-mail de desenvolvimento] Para: ${msg.to} · ${msg.subject}
${await render(msg.react, { plainText: true })}`);
    return;
  }
  const { error } = await resend().emails.send({ from: config.email.from, to: [msg.to], subject: msg.subject, react: msg.react });
  if (error) {
    console.error('Resend', error.name, error.message);
    throw new ApiError(502, 'email_failed', 'Não foi possível enviar o e-mail. Tente outra vez.');
  }
}

const RESEND_COOLDOWN_SECONDS = 60;

/** Cria um link de verificação (uso único) e envia-o para o e-mail do utilizador. */
export async function sendVerificationEmail(user: { id: number; name: string; email: string }): Promise<void> {
  const recent = await one<{ age: number }>(
    `SELECT extract(epoch FROM now() - max(created_at))::int AS age FROM email_tokens WHERE user_id = $1`,
    [user.id],
  );
  if (recent && recent.age !== null && recent.age < RESEND_COOLDOWN_SECONDS) {
    throw new ApiError(429, 'too_soon', `Aguarde ${RESEND_COOLDOWN_SECONDS - recent.age} s para pedir outro e-mail.`);
  }
  const t = token(32);
  await query(
    `INSERT INTO email_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))`,
    [sha256(t), user.id, config.email.verifyTtlHours],
  );
  const link = `${config.publicUrl}/auth/verify-email?token=${encodeURIComponent(t)}`;
  const name = user.name.split(' ')[0] || user.name;
  await sendEmail({
    to: user.email,
    subject: 'Confirme o seu e-mail — Losambo',
    react: createElement(VerifyEmail, { name: name, verifyUrl: link, expiresHours: config.email.verifyTtlHours }),
  });
}

/** Consome o token do link. Devolve o utilizador verificado, ou null se o link for inválido/expirado/usado. */
export async function consumeVerificationToken(raw: string): Promise<number | null> {
  const row = await one<{ user_id: number }>(
    `UPDATE email_tokens SET used_at = now()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
    [sha256(raw)],
  );
  if (!row) return null;
  await query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1', [row.user_id]);
  return row.user_id;
}
