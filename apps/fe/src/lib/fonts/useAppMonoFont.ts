import { useUIStore } from '@vibeterm/stores/react';
import { ensureFontFaceInjected, resolveFontStack } from '@vibeterm/theme';
import { useEffect } from 'react';

// 挂在应用根：把选中的等宽字体派生成 --font-mono 写到 :root，全应用所有 font-mono
// 用户（终端、markdown 代码块、code-viewer、侧边栏等）零改动统一跟随。
//
// 这里**只**注入 @font-face、不强制下载 woff2：默认字体的完整 Nerd 图标两个字重合计 2.3 MB，
// 设备列表 / 设置页根本没有终端，冷启动却要为它们等一轮网络。真正需要精确字形度量的
// 终端自己在挂载前走 document.fonts.load（terminal-ui 的 ensureTerminalFonts、
// TerminalPreview 与分享回放各自直接调 loadTerminalFonts），
// 外壳侧的少量等宽文本由 font-display:swap 先用系统 monospace 顶上、下载完自动替换。
export function useAppMonoFont(): void {
  const fontId = useUIStore((state) => state.terminalFontId);

  useEffect(() => {
    // 先注入 @font-face 再写 --font-mono：family 立刻可解析，避免中途落回 monospace
    ensureFontFaceInjected(fontId);
    const doc = (globalThis as { document?: Document }).document;
    doc?.documentElement.style.setProperty('--font-mono', resolveFontStack(fontId));
  }, [fontId]);
}
