const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeJsonBytes(value: unknown): Uint8Array {
  return textEncoder.encode(JSON.stringify(value));
}

export function decodeJsonBytes(bytes: Uint8Array): unknown {
  return JSON.parse(textDecoder.decode(bytes));
}

export function encodeCtlMessage(msg: { t: string } & Record<string, unknown>): Uint8Array {
  return encodeJsonBytes(msg);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`ctl field ${field} must be a string`);
  }
  return value;
}

export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`ctl field ${field} must be a string`);
  }
  return value;
}

export function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`ctl field ${field} must be a boolean`);
  }
  return value;
}

export function seqToJson(seq: bigint | number): number | string {
  const n = typeof seq === 'bigint' ? seq : BigInt(seq);
  if (n <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(n);
  }
  return n.toString();
}

export function parseSeq(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && value !== '') return BigInt(value);
  throw new Error(`ctl field ${field} must be a seq`);
}

export function defaultScheduler(): import('./types').MeshScheduler {
  return {
    now: () => Date.now(),
    sleep(ms, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new Error('aborted'));
          return;
        }
        const onAbort = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          reject(signal?.reason ?? new Error('aborted'));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort);
      });
    },
    interval(fn, ms) {
      const timer = setInterval(fn, ms);
      return {
        clear() {
          clearInterval(timer);
        },
      };
    },
  };
}

export function jsonStable(value: unknown): string {
  return JSON.stringify(value);
}

export function backoffDelayMs(attempt: number, minMs = 1000, maxMs = 60_000): number {
  const exp = Math.min(maxMs, minMs * 2 ** Math.max(0, attempt));
  const jitter = 0.5 + Math.random() * 0.5;
  return Math.min(maxMs, Math.floor(exp * jitter));
}
