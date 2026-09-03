import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// 首屏体积预算：入口 JS/CSS 的 gzip 字节数超过预算即失败。入口文件名从 dist/index.html 读取，
// 不能 glob `index-*.js`（会命中多个 chunk 给出假数字）。
import { gzipSync } from 'node:zlib';

const DIST = join(import.meta.dir, '..', 'dist');
const BUDGET_GZIP_BYTES = { entryJs: 300_000, entryCss: 30_000 };

function entryAsset(html: string, ext: 'js' | 'css'): string {
  const match = html.match(new RegExp(`assets/index-[A-Za-z0-9_-]+\\.${ext}`));
  if (!match) throw new Error(`dist/index.html 里找不到入口 ${ext}`);
  return match[0];
}

function gzipBytes(path: string): number {
  return gzipSync(readFileSync(path), { level: 9 }).byteLength;
}

const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const rows = [
  { name: 'entry js', file: entryAsset(html, 'js'), budget: BUDGET_GZIP_BYTES.entryJs },
  { name: 'entry css', file: entryAsset(html, 'css'), budget: BUDGET_GZIP_BYTES.entryCss },
];
let failed = false;
for (const row of rows) {
  const actual = gzipBytes(join(DIST, row.file));
  const over = actual > row.budget;
  failed ||= over;
  console.log(
    `${over ? 'FAIL' : 'ok  '} ${row.name.padEnd(9)} ${row.file} gzip=${actual} budget=${row.budget}`
  );
}
if (failed) {
  console.error(
    'bundle budget exceeded：先量清楚是哪块进了入口 chunk（ANALYZE=1 bun run build），再决定拆 chunk 还是调预算'
  );
  process.exit(1);
}
