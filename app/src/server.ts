import cookieParser from 'cookie-parser';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { migrate } from './db.js';
import { ensureWahaDbRole } from './wahaDbRole.js';
import { enforceSingleOwner } from './services/numbers.js';
import { errorHandler } from './http.js';
import { consoleApi } from './routes/console.js';
import { publicApi } from './routes/public.js';
import { googleAuth } from './routes/googleAuth.js';
import { wahaHook } from './routes/wahaHook.js';
import { startSubscriptionSweeper } from './services/subscriptions.js';
import { loadWahaKey, wahaKeySource } from './wahaKey.js';

const app = express();
app.disable('x-powered-by');
if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (config.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.use(wahaHook);
app.use(googleAuth);
app.use('/v1', publicApi);
app.use('/console-api', consoleApi);

const pub = fileURLToPath(new URL('../public', import.meta.url));
app.use(express.static(pub, { extensions: ['html'] }));
app.get('/consola*', (_req, res) => res.sendFile(`${pub}/consola.html`));

app.use(errorHandler);

if (process.env.NODE_ENV === 'production') {
  const weak = [
    ['LOSAMBO_SECRET_KEY', config.secretKey === 'dev-only-secret-change-me' || config.secretKey.length < 16],
    ['WAHA_WEBHOOK_TOKEN', config.waha.webhookToken === 'dev-token-change-me' || config.waha.webhookToken.length < 12],
  ].filter(([, bad]) => bad);
  if (weak.length) {
    console.error(`Recusado: defina valores aleatórios fortes para ${weak.map(([n]) => n).join(', ')}.`);
    process.exit(1);
  }
}

await migrate();
await ensureWahaDbRole();
await enforceSingleOwner();
try {
  await loadWahaKey();
  console.log(
    wahaKeySource() === 'custom'
      ? 'WAHA: a usar a chave fixa (WAHA_USE_CUSTOM_API_KEY=true).'
      : `WAHA: a usar a chave gerada pelo WAHA neste arranque (lida de "docker logs ${config.waha.container}").`,
  );
} catch (err) {
  console.warn(`Aviso: sem chave admin do WAHA — ${(err as Error).message}`);
}
startSubscriptionSweeper();
app.listen(config.port, () => {
  console.log(`Losambo em http://localhost:${config.port}  ·  WAHA: ${config.waha.url}`);
  if (config.secretKey === 'dev-only-secret-change-me') console.warn('Aviso: LOSAMBO_SECRET_KEY não definido — use um valor aleatório em produção.');
});
