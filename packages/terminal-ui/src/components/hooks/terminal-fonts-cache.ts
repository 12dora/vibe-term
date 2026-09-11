// 终端启动资源的进程内缓存：同一 fontId:fontSize 只真正 load 一次。
//
// 字体分两段（见 @vibeterm/theme 的 loadTerminalFontStages）：
//   ready   —— 精确测宽所需的字形，终端启动必须 await；默认字体只是 45 KB 的 latin 子集。
//   upgrade —— Nerd 图标 / 符号兜底，后到；调用方拿到后重绘一次，绝不能挡首帧。
//
// loadTerminalFonts 自身幂等，但每次调用仍要走 document.fonts.load + Promise.all，
// 切 pane 重建终端时这段 await 把控制器创建推到下一个宏任务；命中缓存时返回 undefined，
// 调用方据此同步跳过 await。

import { loadTerminalFontStages } from '@vibeterm/theme';
import { getGhosttyBindings } from 'ghostty-terminal/wasm';

let enginePrewarmed = false;
const loadedFontSets = new Set<string>();
const pendingFontSets = new Map<string, Promise<void>>();
const upgradeStarters = new Map<string, () => Promise<void>>();
const upgradeStarted = new Map<string, Promise<void>>();

function fontSetKey(fontId: string, fontSize: number): string {
  return `${fontId}:${fontSize}`;
}

export function areTerminalFontsLoaded(fontId: string, fontSize: number): boolean {
  return loadedFontSets.has(fontSetKey(fontId, fontSize));
}

/**
 * 提前把 ghostty wasm（555 KB）拉下来并编译。
 * 它与字体没有任何依赖关系，却因为 boot() 先 await 资源、再 createSurface 而被排在字体之后，
 * 冷启动等于把两段下载串起来。这里在字体那一段刚开始时就发起，两者并行。
 * 失败静默：真正的实例化错误由 createSurface 那条路径报，这里重复报只会污染启动态。
 */
export function prewarmTerminalEngine(): void {
  if (enginePrewarmed) return;
  enginePrewarmed = true;
  void getGhosttyBindings().catch(() => undefined);
}

/** 供测试断言「字体那一段还没落地时 wasm 就已经发起」 */
export function isTerminalEnginePrewarmed(): boolean {
  return enginePrewarmed;
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

  const stages = loadTerminalFontStages(fontId, fontSize);
  if (stages.startUpgrade) {
    upgradeStarters.set(key, stages.startUpgrade);
  }
  const task = stages.ready.then(
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
 * 启动二段字形（Nerd 图标 / 符号兜底，合计 2.5 MB）并返回到达信号；
 * 没有二段或该字体集还没开始加载时返回 null。**必须等终端首帧落地之后再调**：
 * 提前开拉会跟子集、wasm 抢同一条窄管子，把首帧又推回去好几秒。
 * 进程内只真正启动一次，重复调用返回同一个 promise。
 */
export function startTerminalFontsUpgrade(fontId: string, fontSize: number): Promise<void> | null {
  const key = fontSetKey(fontId, fontSize);
  const started = upgradeStarted.get(key);
  if (started) return started;
  const starter = upgradeStarters.get(key);
  if (!starter) return null;
  const task = starter();
  upgradeStarted.set(key, task);
  return task;
}

/**
 * 终端启动前的资源准备：宿主钩子 + 字体，并顺带把 wasm 预热排进去。
 * 两边都没有待办时**同步**返回 undefined，启动流程据此完全不走 await，
 * 控制器在同一个 tick 内建起来。
 */
export function loadTerminalResources(
  prepareResources: (() => Promise<void> | void) | undefined,
  fontId: string,
  fontSize: number
): Promise<void> | void {
  prewarmTerminalEngine();
  const prepared = prepareResources?.();
  const fonts = ensureTerminalFonts(fontId, fontSize);
  if (!prepared) return fonts;
  if (!fonts) return prepared;
  return Promise.all([prepared, fonts]).then(() => undefined);
}

export function resetTerminalFontsCacheForTest(): void {
  enginePrewarmed = false;
  loadedFontSets.clear();
  pendingFontSets.clear();
  upgradeStarters.clear();
  upgradeStarted.clear();
}
