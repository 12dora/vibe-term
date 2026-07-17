/**
 * Ghostty WASM 编译产物探针：验证 `new URL('./assets/ghostty-vt.wasm', import.meta.url)`
 * 在 `bun build --compile` 产物内的资源解析（与 gateway headless 终端同路径）。
 *
 * 构建：`bun build --compile ./packages/ghostty-terminal/scripts/smoke-compiled.ts --outfile <out>`
 * 运行：在干净 cwd（无源码树/无 node_modules）直接执行，退出码 0 = 通过。
 */

import { HeadlessTerminal } from '../src/headless';

const term = await HeadlessTerminal.create({ cols: 80, rows: 24, scrollback: 100 });
const marker = 'ghostty-wasm-ok-7f3a';
term.write(`printf '%s\\n' ${marker}\r\n`);

const rendered = term.render();
term.free();

if (!rendered.includes(marker)) {
  console.error(JSON.stringify({ ok: false, error: 'marker_not_in_grid', rendered }));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, marker }));
