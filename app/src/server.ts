import cookieParser from 'cookie-parser';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { migrate } from './db.js';
import { errorHandler } from './http.js';
import { consoleApi } from './routes/console.js';
import { publicApi } from './routes/public.js';
import { googleAuth } from './routes/googleAuth.js';
import { wahaHook } from './routes/wahaHook.js';
import { startSubscriptionSweeper } from './services/subscriptions.js';
import { loadWahaKey, wahaKeySource } from './wahaKey.js';

const app = express();
app.disable('x-powered-by');
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

await migrate();
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
