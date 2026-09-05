import { getShareService } from '../share/share-service';
import type { ShareScope } from './share-scope';

/**
 * ws 层只依赖分享服务的这四个能力。默认走 `apps/gateway/src/share` 的单例，
 * 测试可用 `setShareWsServiceResolver` 顶替；解析失败一律降级为空操作。
 */
export interface ShareWsService {
  recordInput(scope: ShareScope, paneId: string, bytes: Uint8Array): void;
  recordResize(scope: ShareScope, paneId: string, cols: number, rows: number): void;
  onEnded(listener: (shareId: string) => void): () => void;
  setViewerCounter(counter: (shareId: string) => number): void;
}

function defaultShareWsService(): ShareWsService {
  const service = getShareService();
  return {
    recordInput: (scope, paneId, bytes) => service.recordInput(scope, paneId, bytes),
    recordResize: (scope, paneId, cols, rows) => service.recordResize(scope, paneId, cols, rows),
    onEnded: (listener) => service.onEnded((event) => listener(event.shareId)),
    setViewerCounter: (counter) => service.setViewerCounter(counter),
  };
}

let resolveShareService: (() => ShareWsService | null) | null = defaultShareWsService;

export function setShareWsServiceResolver(resolver: (() => ShareWsService | null) | null): void {
  resolveShareService = resolver ?? defaultShareWsService;
}

export function getShareWsService(): ShareWsService | null {
  try {
    return resolveShareService?.() ?? null;
  } catch {
    return null;
  }
}
