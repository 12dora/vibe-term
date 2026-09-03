// 弹层实现 chunk 的唯一 loader：五族共用一份缓存与一次下载。

import { createOverlayLoader, warmOverlay } from './lazy-overlay';

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
