import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib';
import type { Plugin } from 'vite';

// 与运行时 packages/app/src/runtime/static-compression.ts 对齐；.map 会被
// bundle-resources.sh 删掉，构建期不为其产 sidecar，避免留下孤儿 .map.gz/.br。
const COMPRESSIBLE = new Set([
  '.js',
  '.mjs',
  '.css',
  '.html',
  '.json',
  '.svg',
  '.wasm',
  '.txt',
  '.webmanifest',
]);

const GZIP_MTIME_OFFSET = 4;
const GZIP_OS_OFFSET = 9;
const GZIP_OS_UNKNOWN = 255;

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export function gzipSidecarBytes(raw: Uint8Array): Uint8Array {
  const out = gzipSync(raw, { level: 9 });
  out[GZIP_MTIME_OFFSET] = 0;
  out[GZIP_MTIME_OFFSET + 1] = 0;
  out[GZIP_MTIME_OFFSET + 2] = 0;
  out[GZIP_MTIME_OFFSET + 3] = 0;
  out[GZIP_OS_OFFSET] = GZIP_OS_UNKNOWN;
  return out;
}

export function brotliSidecarBytes(raw: Uint8Array): Uint8Array {
  return brotliCompressSync(raw, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength,
    },
  });
}

export function shouldCompressPath(filePath: string): boolean {
  if (filePath.endsWith('.gz') || filePath.endsWith('.br')) return false;
  return COMPRESSIBLE.has(extname(filePath).toLowerCase());
}

export function writeCompressionSidecars(filePath: string): {
  raw: number;
  gzip: number;
  br: number;
} {
  const raw = readFileSync(filePath);
  const gzip = gzipSidecarBytes(raw);
  const br = brotliSidecarBytes(raw);
  if (gzip.byteLength < raw.byteLength) {
    writeFileSync(`${filePath}.gz`, gzip);
  }
  if (br.byteLength < raw.byteLength) {
    writeFileSync(`${filePath}.br`, br);
  }
  return { raw: raw.byteLength, gzip: gzip.byteLength, br: br.byteLength };
}

function formatBytes(n: number): string {
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

export function compressDistDir(outDir: string): {
  files: number;
  raw: number;
  gzip: number;
  br: number;
} {
  let files = 0;
  let raw = 0;
  let gzip = 0;
  let br = 0;
  for (const file of walkFiles(outDir)) {
    if (!shouldCompressPath(file)) continue;
    const sizes = writeCompressionSidecars(file);
    files += 1;
    raw += sizes.raw;
    gzip += sizes.gzip;
    br += sizes.br;
  }
  return { files, raw, gzip, br };
}

export function compressStaticPlugin(): Plugin {
  let outDir = '';
  return {
    name: 'vibeterm-compress-static',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      outDir = join(config.root, config.build.outDir);
    },
    closeBundle: {
      sequential: true,
      order: 'post',
      handler() {
        if (!outDir) return;
        try {
          statSync(outDir);
        } catch {
          return;
        }
        const result = compressDistDir(outDir);
        console.log(
          `[vite] compress-static: ${result.files} files raw=${formatBytes(result.raw)} ` +
            `gzip=${formatBytes(result.gzip)} br=${formatBytes(result.br)}`
        );
      },
    },
  };
}
