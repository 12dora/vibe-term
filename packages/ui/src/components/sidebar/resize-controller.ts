// 侧栏拖拽改宽的时序：指针事件率（触控板 ~120 Hz）远高于帧率，且落盘只该发生一次。
//
// 拆成不依赖 React / DOM 的控制器有两个原因：一是 pointermove → setState → localStorage
// 这条同步链路是拖拽卡顿的主因，改动必须能被单元测试盯住；二是「一次拖拽只落一次盘」
// 这条契约在组件里没法断言（仓库测试环境无 DOM）。

import { type SidebarSide, resizedSidebarWidth } from './width';

export interface SidebarResizeHost {
  /** 只改内存宽度 */
  setWidth: (width: number) => void;
  /** 落盘，一次拖拽只调一次 */
  commitWidth: () => void;
  setResizing: (resizing: boolean) => void;
  /** 返回 null 表示当前环境没有 rAF，控制器会退回同步应用 */
  requestFrame: (callback: () => void) => unknown | null;
  cancelFrame: (handle: unknown) => void;
}

export interface SidebarResizeController {
  start: (pointerId: number, clientX: number, width: number) => void;
  move: (pointerId: number, clientX: number, side: SidebarSide) => void;
  end: (pointerId: number) => void;
  /** 卸载收尾：拖拽途中侧栏被折叠会直接卸载 resizer */
  dispose: () => void;
}

export const domResizeFrames: Pick<SidebarResizeHost, 'requestFrame' | 'cancelFrame'> = {
  requestFrame: (callback) =>
    typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : null,
  cancelFrame: (handle) => {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle as number);
  },
};

export function createSidebarResizeController(host: SidebarResizeHost): SidebarResizeController {
  let drag: { pointerId: number; startX: number; startWidth: number } | null = null;
  let frame: unknown = null;
  let pendingWidth: number | null = null;

  const cancelFrame = () => {
    if (frame === null) return;
    host.cancelFrame(frame);
    frame = null;
  };

  const applyPending = () => {
    cancelFrame();
    const next = pendingWidth;
    pendingWidth = null;
    if (next !== null) host.setWidth(next);
  };

  const finish = () => {
    drag = null;
    applyPending();
    host.commitWidth();
    host.setResizing(false);
  };

  return {
    start: (pointerId, clientX, width) => {
      drag = { pointerId, startX: clientX, startWidth: width };
      host.setResizing(true);
    },
    move: (pointerId, clientX, side) => {
      if (!drag || drag.pointerId !== pointerId) return;
      pendingWidth = resizedSidebarWidth(drag.startWidth, clientX - drag.startX, side);
      if (frame !== null) return;
      const handle = host.requestFrame(() => {
        frame = null;
        applyPending();
      });
      if (handle === null) {
        applyPending();
        return;
      }
      frame = handle;
    },
    end: (pointerId) => {
      if (!drag || drag.pointerId !== pointerId) return;
      finish();
    },
    dispose: () => {
      if (drag) {
        finish();
        return;
      }
      cancelFrame();
    },
  };
}
