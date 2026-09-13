import { useUIStore } from '@vibeterm/stores/react';
import { cn } from '@vibeterm/ui';
import { useTranslation } from 'react-i18next';
import { ReadOnlyTerminal, type ReadOnlyTerminalHandle } from './ReadOnlyTerminal';

// 写死的预览内容：~10 行带 ANSI 颜色、含中文/符号/Nerd 图标的代码块，
// 用于整体预览字号、字体、行高效果。\r\n 为终端换行。
// 配色须在深/浅两套 seoul256 主题下都可读。seoul256-dark 的 black/brightBlack 均为
// #000000，故弱化文字不可用 90（bright black）——深色背景上看不见；改用 39（默认前景，
// 主题感知：深色 #d0d0d0 / 浅色 #616161）。同理别用 white/brightWhite 当文字（浅色下不可见）。
const E = '\x1b';
export const PREVIEW_ANSI = [
  `${E}[1;32m  feat/terminal-font${E}[0m  ${E}[39m~/projects/vibeterm${E}[0m`,
  `${E}[39m// 渲染中文与彩色代码块：字号 / 字体 / 行高 实时预览${E}[0m`,
  `${E}[35mexport const${E}[0m ${E}[36mgreeting${E}[0m = ${E}[33m"你好，世界 🌏"${E}[0m;`,
  `${E}[35mfunction${E}[0m ${E}[34mfib${E}[0m(${E}[36mn${E}[0m: ${E}[32mnumber${E}[0m) {`,
  `  ${E}[35mreturn${E}[0m n ${E}[31m<${E}[0m ${E}[33m2${E}[0m ${E}[31m?${E}[0m n ${E}[31m:${E}[0m ${E}[34mfib${E}[0m(n${E}[31m-${E}[0m${E}[33m1${E}[0m) ${E}[31m+${E}[0m ${E}[34mfib${E}[0m(n${E}[31m-${E}[0m${E}[33m2${E}[0m);`,
  '}',
  `${E}[32m+ 新增${E}[0m  ${E}[31m- 删除${E}[0m  ${E}[33m~ 修改${E}[0m   ${E}[36m通过测试 ✓${E}[0m`,
  `${E}[1;34m dir/${E}[0m  ${E}[32m file.ts${E}[0m  ${E}[33m README.md${E}[0m  ${E}[35m config${E}[0m`,
  `${E}[39m$${E}[0m bun run ${E}[36mbuild:fonts${E}[0m  ${E}[32m✓${E}[0m  ${E}[39m14MB${E}[0m`,
  `${E}[7m NORMAL ${E}[0m ${E}[39m UTF-8  LF  TypeScript${E}[0m`,
].join('\r\n');

export function writeTerminalPreviewContent(handle: ReadOnlyTerminalHandle): void {
  handle.write(PREVIEW_ANSI);
}

export function TerminalPreview({ className }: { className?: string }) {
  const { t } = useTranslation();
  const fontSize = useUIStore((state) => state.terminalFontSize);
  const lineHeight = useUIStore((state) => state.terminalLineHeight);
  const heightPx = Math.ceil(fontSize * lineHeight * 12);

  return (
    <div
      className={cn('relative w-full overflow-hidden rounded-md border', className)}
      data-testid="terminal-preview"
      style={{ height: `${heightPx}px` }}
    >
      <ReadOnlyTerminal
        testId="terminal-preview-mount"
        viewportPan={false}
        selection={false}
        scrollback={100}
        onReady={writeTerminalPreviewContent}
        ariaLabel={t('settings.terminal.preview')}
      />
    </div>
  );
}
