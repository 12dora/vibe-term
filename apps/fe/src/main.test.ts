// 首屏 entry 的静态依赖守卫：main.tsx 只用 terminal-ui 的键盘避让 hook，
// 从包根引会把 Ghostty 终端整条图拖进 entry chunk（约 140 KiB raw）。

import { describe, expect, test } from 'bun:test';

describe('main.tsx 的静态依赖', () => {
  test('键盘避让只从窄子路径引，不碰 @tmex/terminal-ui 包根', async () => {
    const source = await Bun.file(`${import.meta.dir}/main.tsx`).text();
    const paths = new Bun.Transpiler({ loader: 'tsx' }).scanImports(source).map((e) => e.path);
    expect(paths).toContain('@tmex/terminal-ui/hooks/use-keyboard-avoidance');
    expect(paths).not.toContain('@tmex/terminal-ui');
  });
});
