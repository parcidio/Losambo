import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';

const run = promisify(execFile);

export type KeySource = 'custom' | 'generated' | 'none';

let current = '';
let source: KeySource = 'none';
let loading: Promise<string> | null = null;

/** Usar a chave fixa só quando WAHA_USE_CUSTOM_API_KEY=true e WAHA_API_KEY está preenchido. */
function customAllowed(): boolean {
  return config.waha.useCustomKey && !!config.waha.customKey;
}

/**
 * Sem chave fixa, o WAHA gera uma chave nova em cada arranque e escreve
 * "WAHA_API_KEY=<valor>" nos logs. Lê a mais recente com `docker logs`.
 */
async function readGeneratedKey(): Promise<string> {
  // A chave aparece no início do arranque; lê os logs desde o último arranque do container.
  const { stdout: started } = await run('docker', ['inspect', '-f', '{{.State.StartedAt}}', config.waha.container], {
    windowsHide: true,
  });
  const { stdout, stderr } = await run('docker', ['logs', '--since', started.trim(), config.waha.container], {
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const matches = [...`${stdout}\n${stderr}`.matchAll(/^\s*WAHA_API_KEY=(\S+)\s*$/gm)];
  const key = matches.at(-1)?.[1] ?? '';
  if (!key) {
    throw new Error(
      `Não encontrei "WAHA_API_KEY=" nos logs do container "${config.waha.container}". ` +
        'O WAHA só gera a chave quando arranca sem WAHA_API_KEY definido.',
    );
  }
  return key;
}

/** (Re)carrega a chave admin do WAHA conforme a configuração. */
export async function loadWahaKey(): Promise<string> {
  if (customAllowed()) {
    current = config.waha.customKey;
    source = 'custom';
    return current;
  }
  loading ??= readGeneratedKey()
    .then((key) => {
      current = key;
      source = 'generated';
      return key;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

export function wahaKey(): string {
  return current;
}

export function wahaKeySource(): KeySource {
  return source;
}

/** Depois de um 401 do WAHA: com chave gerada, o WAHA pode ter reiniciado — volta a ler. */
export async function refreshAfterUnauthorized(): Promise<boolean> {
  if (customAllowed()) return false;
  const before = current;
  try {
    return (await loadWahaKey()) !== before;
  } catch {
    return false;
  }
}
