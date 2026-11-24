import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import express, { Router, type Response } from 'express';

/**
 * Site estático (páginas e /assets) com "cache busting":
 * - cada ligação /assets/x passa a /assets/x?v=<impressão do conteúdo>; um deploy que muda o ficheiro muda o endereço,
 *   por isso o navegador e o Cloudflare vão sempre buscar a versão nova;
 * - os ficheiros com ?v= podem ficar em cache um ano (imutáveis);
 * - as páginas HTML são "no-cache": o navegador confirma sempre se há versão nova.
 * Lê tudo uma vez no arranque (os ficheiros só mudam com um novo deploy).
 */
export function staticSite(pub: string): Router {
  const assetsDir = join(pub, 'assets');
  const versions = new Map<string, string>();
  for (const f of readdirSync(assetsDir)) {
    versions.set(f, createHash('sha256').update(readFileSync(join(assetsDir, f))).digest('hex').slice(0, 12));
  }
  const pages = new Map<string, string>();
  for (const f of readdirSync(pub).filter((x) => x.endsWith('.html'))) {
    const html = readFileSync(join(pub, f), 'utf8').replace(/(["'(])\/assets\/([\w.-]+)(?=["')])/g, (m, pre: string, name: string) =>
      versions.has(name) ? `${pre}/assets/${name}?v=${versions.get(name)}` : m,
    );
    pages.set(f, html);
  }

  const sendPage = (res: Response, file: string) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(pages.get(file));
  };

  const r = Router();
  r.use(
    '/assets',
    express.static(assetsDir, {
      setHeaders: (res, _path) => {
        // Com ?v= o endereço muda a cada versão; sem ?v= (pedidos antigos), revalida sempre.
        const req = (res as unknown as { req?: { query?: Record<string, unknown> } }).req;
        res.setHeader('Cache-Control', req?.query?.v ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    }),
  );
  r.get('/', (_req, res) => sendPage(res, 'index.html'));
  r.get(/^\/consola(\/.*)?$/, (_req, res) => sendPage(res, 'consola.html'));
  for (const f of pages.keys()) {
    const name = f.replace(/\.html$/, '');
    if (name === 'index' || name === 'consola') continue;
    r.get([`/${name}`, `/${f}`], (_req, res) => sendPage(res, f));
  }
  return r;
}
