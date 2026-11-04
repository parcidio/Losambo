import { ApiError } from '../http.js';
import type { WahaClient } from '../waha.js';
import type { NumberRow } from './numbers.js';

// Janela deslizante em memória por número. Para vários processos, trocar por Redis.
const windows = new Map<number, number[]>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function reserveSlot(n: NumberRow): void {
  const now = Date.now();
  const recent = (windows.get(n.id) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= n.max_per_minute) {
    windows.set(n.id, recent);
    throw new ApiError(429, 'rate_limited', `Máximo de ${n.max_per_minute} mensagens por minuto neste número.`);
  }
  recent.push(now);
  windows.set(n.id, recent);
}

export function sentLastMinute(numberId: number): number {
  const now = Date.now();
  return (windows.get(numberId) ?? []).filter((t) => now - t < 60_000).length;
}

/**
 * Envia com ritmo humano: teto por minuto, atraso aleatório e "a escrever…".
 */
export async function pacedSend<T>(n: NumberRow, waha: WahaClient, chatId: string, text: string | null, send: () => Promise<T>): Promise<T> {
  reserveSlot(n);
  if (n.typing) {
    await waha.startTyping(n.session_name, chatId).catch(() => undefined);
    const len = text?.length ?? 20;
    await sleep(Math.min(4000, 700 + len * 40 + Math.random() * 800));
  } else {
    await sleep(300 + Math.random() * 700);
  }
  try {
    return await send();
  } finally {
    if (n.typing) await waha.stopTyping(n.session_name, chatId).catch(() => undefined);
  }
}
