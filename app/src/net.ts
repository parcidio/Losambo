import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { config } from './config.js';
import { ApiError } from './http.js';

/**
 * Pedidos HTTP para URLs indicados pelos clientes (webhooks, ficheiros a enviar).
 * Contra SSRF: só http/https, sem redirecionamentos, e o IP é validado no momento da ligação
 * (o mesmo que é usado — sem janela para DNS rebinding). Bloqueia redes privadas, loopback,
 * link-local (metadados da cloud), CGNAT e a rede interna dos contentores.
 */

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family === 6) {
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return !blocked.check(mapped[1], 'ipv4');
    return !blocked.check(address, 'ipv6');
  }
  return false;
}

/** Resolve o nome e recusa a ligação se algum endereço não for público. */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = addresses as unknown as LookupAddress[];
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (bad || !list.length) {
      return callback(Object.assign(new Error(`endereço não permitido (${hostname})`), { code: 'EBLOCKED' }), '', 0);
    }
    if ((options as { all?: boolean }).all) return (callback as any)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

export function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(400, 'invalid_url', 'URL inválido.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ApiError(400, 'invalid_url', 'Só são aceites URLs http(s).');
  }
  if (url.username || url.password) throw new ApiError(400, 'invalid_url', 'O URL não pode ter credenciais.');
  if (!config.allowPrivateUrls && isIP(url.hostname.replace(/^\[|\]$/g, '')) && !isPublicAddress(url.hostname.replace(/^\[|\]$/g, ''))) {
    throw new ApiError(400, 'invalid_url', 'Endereços privados ou internos não são permitidos.');
  }
  return url;
}

export interface SafeResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export function safeRequest(
  raw: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string | Buffer; timeoutMs?: number; maxBytes?: number } = {},
): Promise<SafeResponse> {
  const url = assertSafeUrl(raw);
  const mod = url.protocol === 'https:' ? https : http;
  const maxBytes = opts.maxBytes ?? 1024 * 1024;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: opts.method ?? 'GET',
        headers: opts.headers,
        lookup: config.allowPrivateUrls ? undefined : guardedLookup,
        timeout: opts.timeoutMs ?? 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy(Object.assign(new Error(`resposta maior que ${Math.round(maxBytes / 1024 / 1024)} MB`), { code: 'ETOOBIG' }));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('tempo esgotado')));
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Descarrega um ficheiro (para enviar por WhatsApp) e devolve-o em base64 — o WAHA nunca recebe o URL. */
export async function downloadFile(
  raw: string,
  maxBytes = 16 * 1024 * 1024,
): Promise<{ data: string; mimetype: string; filename: string }> {
  let res: SafeResponse;
  try {
    res = await safeRequest(raw, { timeoutMs: 20_000, maxBytes });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, 'file_unreachable', `Não foi possível descarregar o ficheiro: ${(err as Error).message}`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ApiError(400, 'file_unreachable', `Não foi possível descarregar o ficheiro (HTTP ${res.status}).`);
  }
  const mimetype = String(res.headers['content-type'] ?? 'application/octet-stream').split(';')[0].trim();
  const filename = decodeURIComponent(new URL(raw).pathname.split('/').pop() || 'ficheiro');
  return { data: res.body.toString('base64'), mimetype, filename };
}
