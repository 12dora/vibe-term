// 首屏体积预算：浏览器在拿到 index.html 后**立刻**要下载的那一批 JS/CSS 的 gzip 字节数，
// 超预算即失败。口径是 index.html 里的 `<script type=module>` + `modulepreload` + 样式表，
// 不是单个 `index-*.js`：拆出 vendor chunk 后入口文件变小了，但首屏该下的一个都没少。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const DIST = join(import.meta.dir, '..', 'dist');
const BUDGET_GZIP_BYTES = { entryJs: 300_000, entryCss: 30_000 };

const ASSET = /\/?(assets\/[A-Za-z0-9._-]+\.(?:js|css))/;

function attrValue(tag: string, attr: string): string | null {
  const match = tag.match(new RegExp(`${attr}="([^"]+)"`));
  return match?.[1] ?? null;
}

/** 首屏 JS：入口 module 脚本 + 它的 modulepreload 集合（vite 只给首屏依赖发 modulepreload）。 */
export function entryScripts(html: string): string[] {
  const files: string[] = [];
  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
    if (!/type="module"/.test(tag)) continue;
    const file = attrValue(tag, 'src')?.match(ASSET)?.[1];
    if (file) files.push(file);
  }
  for (const tag of html.match(/<link\b[^>]*>/g) ?? []) {
    if (!/rel="modulepreload"/.test(tag)) continue;
    const file = attrValue(tag, 'href')?.match(ASSET)?.[1];
    if (file) files.push(file);
  }
  return [...new Set(files)];
}

export function entryStyles(html: string): string[] {
  const files: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/g) ?? []) {
    if (!/rel="stylesheet"/.test(tag)) continue;
    const file = attrValue(tag, 'href')?.match(ASSET)?.[1];
    if (file) files.push(file);
  }
  return [...new Set(files)];
}

function gzipBytes(path: string): number {
  return gzipSync(readFileSync(path), { level: 9 }).byteLength;
}

const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const rows = [
  { name: 'entry js', files: entryScripts(html), budget: BUDGET_GZIP_BYTES.entryJs },
  { name: 'entry css', files: entryStyles(html), budget: BUDGET_GZIP_BYTES.entryCss },
];
let failed = false;
for (const row of rows) {
  if (row.files.length === 0) throw new Error(`dist/index.html 里找不到首屏 ${row.name}`);
  const sizes = row.files.map((file) => [file, gzipBytes(join(DIST, file))] as const);
  const actual = sizes.reduce((sum, [, bytes]) => sum + bytes, 0);
  const over = actual > row.budget;
  failed ||= over;
  const detail = sizes.map(([file, bytes]) => `${file}=${bytes}`).join(' + ');
  console.log(
    `${over ? 'FAIL' : 'ok  '} ${row.name.padEnd(9)} gzip=${actual} budget=${row.budget}  (${detail})`
  );
}
if (failed) {
  console.error(
    'bundle budget exceeded：先量清楚是哪块进了首屏（ANALYZE=1 bun run build），再决定拆 chunk 还是调预算'
  );
  process.exit(1);
}
