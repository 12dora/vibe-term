// 弹层实现 chunk 的唯一 loader：五族共用一份缓存与一次下载。

import { type OverlayGate, createOverlayLoader, warmOverlay } from './lazy-overlay';

export type OverlaysImpl = typeof import('./components/overlays-impl');

export const overlayLoader = createOverlayLoader<OverlaysImpl>(
  () => import('./components/overlays-impl')
);

warmOverlay(overlayLoader);

/** 仅供测试：替换弹层实现的动态 import 并清空缓存 */
export function setOverlaysImplImporterForTests(
  importer: (() => Promise<OverlaysImpl>) | null
): void {
  overlayLoader.resetForTests(importer);
}

/** 触发器/部件被单独渲染（没有外层 Root）时的空 gate */
export const NO_OVERLAY_GATE: OverlayGate<OverlaysImpl> = {
  impl: null,
  unavailable: false,
  requestLoad: () => undefined,
  requestOpen: () => undefined,
  retry: () => undefined,
};
