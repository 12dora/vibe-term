// 终端字体加载的进程内缓存：同一 fontId:fontSize 只真正 load 一次。
// loadTerminalFonts 自身幂等，但每次调用仍要走四次 document.fonts.load + Promise.all，
// 切 pane 重建终端时这段 await 把控制器创建推到下一个宏任务；命中缓存时返回 undefined，
// 调用方据此同步跳过 await。

import { loadTerminalFonts } from '@tmex/theme';

const loadedFontSets = new Set<string>();
const pendingFontSets = new Map<string, Promise<void>>();

function fontSetKey(fontId: string, fontSize: number): string {
  return `${fontId}:${fontSize}`;
}

export function areTerminalFontsLoaded(fontId: string, fontSize: number): boolean {
  return loadedFontSets.has(fontSetKey(fontId, fontSize));
}

/** 已就绪返回 undefined（同步可用），否则返回该字体集共享的加载 Promise */
export function ensureTerminalFonts(fontId: string, fontSize: number): Promise<void> | undefined {
  const key = fontSetKey(fontId, fontSize);
  if (loadedFontSets.has(key)) {
    return undefined;
  }
  const inflight = pendingFontSets.get(key);
  if (inflight) {
    return inflight;
  }

  const task = loadTerminalFonts(fontId, fontSize).then(
    () => {
      pendingFontSets.delete(key);
      loadedFontSets.add(key);
    },
    (error: unknown) => {
      pendingFontSets.delete(key);
      throw error;
    }
  );
  pendingFontSets.set(key, task);
  return task;
}

/**
 * 终端启动前的资源准备：宿主钩子 + 字体。两边都没有待办时**同步**返回 undefined，
 * 启动流程据此完全不走 await，控制器在同一个 tick 内建起来。
 */
export function loadTerminalResources(
  prepareResources: (() => Promise<void> | void) | undefined,
  fontId: string,
  fontSize: number
): Promise<void> | void {
  const prepared = prepareResources?.();
  const fonts = ensureTerminalFonts(fontId, fontSize);
  if (!prepared) return fonts;
  if (!fonts) return prepared;
  return Promise.all([prepared, fonts]).then(() => undefined);
}

export function resetTerminalFontsCacheForTest(): void {
  loadedFontSets.clear();
  pendingFontSets.clear();
}
