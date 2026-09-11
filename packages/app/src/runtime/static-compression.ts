import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib';

export type ContentEncoding = 'br' | 'gzip';

export const COMPRESSIBLE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.css',
  '.html',
  '.json',
  '.svg',
  '.wasm',
  '.map',
  '.txt',
  '.webmanifest',
]);

export const DEFAULT_COMPRESSION_CACHE_BYTES = 64 * 1024 * 1024;

const GZIP_MTIME_OFFSET = 4;
const GZIP_OS_OFFSET = 9;
const GZIP_OS_UNKNOWN = 255;

export function isCompressiblePath(filePath: string): boolean {
  return COMPRESSIBLE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

export function sidecarPath(filePath: string, encoding: ContentEncoding): string {
  return encoding === 'br' ? `${filePath}.br` : `${filePath}.gz`;
}

function parseQValues(header: string): Map<string, number> {
  const q = new Map<string, number>();
  for (const part of header.split(',')) {
    const [nameRaw, ...params] = part.trim().split(';');
    const name = nameRaw?.trim().toLowerCase();
    if (!name) continue;
    let quality = 1;
    for (const param of params) {
      const [key, value] = param.split('=').map((item) => item.trim().toLowerCase());
      if (key !== 'q' || value === undefined) continue;
      const parsed = Number(value);
      if (Number.isFinite(parsed)) quality = parsed;
    }
    q.set(name, quality);
  }
  return q;
}

function encodingAllowed(q: Map<string, number>, encoding: ContentEncoding): boolean {
  if (q.has(encoding)) return (q.get(encoding) ?? 0) > 0;
  if (q.has('*')) return (q.get('*') ?? 0) > 0;
  return false;
}

/** 客户端显式接受时优先 br，其次 gzip；未声明或 q=0 则 identity（返回 null）。 */
export function negotiateEncoding(header: string | null): ContentEncoding | null {
  if (!header || header.trim() === '') return null;
  const q = parseQValues(header);
  if (encodingAllowed(q, 'br')) return 'br';
  if (encodingAllowed(q, 'gzip')) return 'gzip';
  return null;
}

export function gzipBytes(raw: Uint8Array): Uint8Array {
  const out = gzipSync(raw, { level: 9 });
  out[GZIP_MTIME_OFFSET] = 0;
  out[GZIP_MTIME_OFFSET + 1] = 0;
  out[GZIP_MTIME_OFFSET + 2] = 0;
  out[GZIP_MTIME_OFFSET + 3] = 0;
  out[GZIP_OS_OFFSET] = GZIP_OS_UNKNOWN;
  return out;
}

export function brotliBytes(raw: Uint8Array, quality: number): Uint8Array {
  return brotliCompressSync(raw, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: quality,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength,
    },
  });
}

/** 运行时即时压缩用较快的 br 档；构建期 sidecar 用质量 11。 */
export function compressBytes(raw: Uint8Array, encoding: ContentEncoding): Uint8Array {
  return encoding === 'gzip' ? gzipBytes(raw) : brotliBytes(raw, 5);
}

export function variantEtag(
  size: number,
  mtimeMs: number,
  encoding: ContentEncoding | null
): string {
  const base = `${size}-${Math.trunc(mtimeMs)}`;
  return encoding ? `W/"${base}-${encoding}"` : `W/"${base}"`;
}

export function tryReadFreshSidecar(sourcePath: string, encoding: ContentEncoding): string | null {
  const side = sidecarPath(sourcePath, encoding);
  try {
    const source = statSync(sourcePath);
    const sidecar = statSync(side);
    if (sidecar.size > 0 && sidecar.mtimeMs >= source.mtimeMs) return side;
  } catch {
    return null;
  }
  return null;
}

export function tryWriteSidecar(dest: string, bytes: Uint8Array): boolean {
  const tmp = `${dest}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, dest);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // 只读目录里连临时文件都写不出来
    }
    return false;
  }
}

export class CompressedBodyCache {
  private readonly map = new Map<string, Uint8Array>();
  private used = 0;

  constructor(private readonly maxBytes = DEFAULT_COMPRESSION_CACHE_BYTES) {}

  get(key: string): Uint8Array | undefined {
    const value = this.map.get(key);
    if (!value) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: Uint8Array): void {
    if (value.byteLength > this.maxBytes) return;
    const existing = this.map.get(key);
    if (existing) {
      this.used -= existing.byteLength;
      this.map.delete(key);
    }
    while (this.used + value.byteLength > this.maxBytes && this.map.size > 0) {
      const oldest = this.map.keys().next().value;
      if (typeof oldest !== 'string') break;
      const evicted = this.map.get(oldest);
      this.map.delete(oldest);
      if (evicted) this.used -= evicted.byteLength;
    }
    this.map.set(key, value);
    this.used += value.byteLength;
  }

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    return this.used;
  }

  clear(): void {
    this.map.clear();
    this.used = 0;
  }
}

export type EncodedBody = {
  encoding: ContentEncoding | null;
  filePath?: string;
  bytes?: Uint8Array;
};

const defaultCache = new CompressedBodyCache();

export function resetCompressionCacheForTests(): void {
  defaultCache.clear();
}

export function resolveEncodedBody(
  filePath: string,
  encoding: ContentEncoding | null,
  cache: CompressedBodyCache = defaultCache
): EncodedBody {
  if (!encoding) return { encoding: null, filePath };
  const sidecar = tryReadFreshSidecar(filePath, encoding);
  if (sidecar) return { encoding, filePath: sidecar };

  const st = statSync(filePath);
  const cacheKey = `${filePath}:${st.mtimeMs}:${st.size}:${encoding}`;
  const cached = cache.get(cacheKey);
  if (cached) return { encoding, bytes: cached };

  const source = readFileSync(filePath);
  const compressed = compressBytes(source, encoding);
  if (compressed.byteLength >= source.byteLength) {
    return { encoding: null, filePath };
  }
  const dest = sidecarPath(filePath, encoding);
  if (tryWriteSidecar(dest, compressed)) {
    return { encoding, filePath: dest };
  }
  cache.set(cacheKey, compressed);
  return { encoding, bytes: compressed };
}
