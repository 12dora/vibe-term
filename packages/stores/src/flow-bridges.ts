// 宿主外壳桥接：让 toast action 回调等「非 React context」代码也能 navigate / 强开手机端 sidebar。
// 由 <FlowBridges/>（挂在 RouterProvider + SidebarProvider 内）在挂载时注册具体实现。
//
// 这两件东西按宿主外壳（router + sidebar）唯一，不按 node runtime 分身；但路由切换时新旧
// node 边界会短暂并存，因此用栈式注册：最后注册的生效，注册返回自身的注销函数，
// 旧边界卸载不会把新边界的实现一并抹掉。

type NavigateFn = (to: string, opts?: { replace?: boolean }) => void;

interface SidebarBridgeApi {
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
}

function createBridgeStack<T>() {
  const stack: T[] = [];
  return {
    register(value: T): () => void {
      stack.push(value);
      return () => {
        const index = stack.lastIndexOf(value);
        if (index >= 0) stack.splice(index, 1);
      };
    },
    top(): T | null {
      return stack.length > 0 ? stack[stack.length - 1] : null;
    },
    clear(): void {
      stack.length = 0;
    },
  };
}

const navigateStack = createBridgeStack<NavigateFn>();
const sidebarStack = createBridgeStack<SidebarBridgeApi>();

const noopUnregister = () => {};

/** 注册导航桥，返回注销函数；传 null 清空全部注册（宿主整体卸载）。 */
export function setNavigateBridge(fn: NavigateFn | null): () => void {
  if (!fn) {
    navigateStack.clear();
    return noopUnregister;
  }
  return navigateStack.register(fn);
}

export function bridgeNavigate(to: string, opts?: { replace?: boolean }): void {
  navigateStack.top()?.(to, opts);
}

/** 注册 sidebar 桥，返回注销函数；传 null 清空全部注册。 */
export function setSidebarBridge(api: SidebarBridgeApi | null): () => void {
  if (!api) {
    sidebarStack.clear();
    return noopUnregister;
  }
  return sidebarStack.register(api);
}

export function bridgeIsMobile(): boolean {
  return sidebarStack.top()?.isMobile ?? false;
}

export function bridgeOpenMobileSidebar(): void {
  const api = sidebarStack.top();
  if (api?.isMobile) api.setOpenMobile(true);
}

export function bridgeCloseMobileSidebar(): void {
  const api = sidebarStack.top();
  if (api?.isMobile) api.setOpenMobile(false);
}

/** 仅测试用：清空全部注册。 */
export function resetFlowBridgesForTest(): void {
  navigateStack.clear();
  sidebarStack.clear();
}
