// 弹层实现的按需边界。
//
// menu / dialog / alert-dialog / sheet / tooltip 这几族的真正实现拖着 `floating-ui-react`
// （FloatingFocusManager / useDismiss / useListNavigation / safePolygon）、`tabbable` 与
// `@floating-ui/*`，实测占首屏入口 chunk 约 60 KB gzip；而它们全都是「不打开一个字节都用不上」
// 的东西。这里把实现挪进独立 chunk：入口只留触发器与空壳，实现随 `import()` 并行下载，
// 到货后就地替换。首屏少解析/执行这一大段，弹层本身的交互语义不变。
//
// 不用 `React.lazy`：它把 reject 永久缓存成 Rejected 并在渲染期一直抛，而 `Suspense` 接不住
// 异常，整条路由会被这个错误替换掉。发版后旧 index.html 指向的 chunk 已经不存在（iOS 主屏
// PWA 尤其顽固地缓存启动页），`import()` 就是 404。这里与 `deferred-watch-dialog` 用同一套：
// 显式 loader（失败不缓存）+ 有限次就地重试 + 兜底整页刷新（每会话至多一次，杜绝刷新循环）。

import { useRender } from '@base-ui/react/use-render';
import {
  type ComponentType,
  type ReactElement,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from 'react';

/** 就地重试上限，超过后（且用户确实在等这个弹层）才走整页刷新 */
export const MAX_OVERLAY_LOAD_RETRIES = 2;

const RELOAD_GUARD_KEY = 'tmex.overlay-chunk-reloaded';

export interface OverlayLoader<M> {
  /** 已加载则同步返回，否则 null */
  peek(): M | null;
  load(): Promise<M>;
  /** 仅供测试：替换 importer 并清空缓存 */
  resetForTests(importer?: (() => Promise<M>) | null): void;
}

export function createOverlayLoader<M>(defaultImporter: () => Promise<M>): OverlayLoader<M> {
  let importer = defaultImporter;
  let loaded: M | null = null;
  let inflight: Promise<M> | null = null;

  return {
    peek: () => loaded,
    load() {
      if (loaded) return Promise.resolve(loaded);
      if (!inflight) {
        inflight = importer().then(
          (module) => {
            loaded = module;
            inflight = null;
            return module;
          },
          (error: unknown) => {
            inflight = null;
            throw error;
          }
        );
      }
      return inflight;
    },
    resetForTests(next) {
      importer = next ?? defaultImporter;
      loaded = null;
      inflight = null;
    },
  };
}

/**
 * 模块求值时就发起下载：与入口 chunk 的其余启动工作并行，首帧之前多半已经到货，
 * 用户碰到触发器时不会看见任何替换。失败静默，交给 `useOverlayModule` 的重试与兜底。
 */
export function warmOverlay<M>(loader: OverlayLoader<M>): void {
  void loader.load().catch(() => undefined);
}

let reloadRequested = false;

/** 仅供测试：清掉「本会话已刷新过」的标记 */
export function resetOverlayReloadGuardForTests(): void {
  reloadRequested = false;
  try {
    globalThis.sessionStorage?.removeItem(RELOAD_GUARD_KEY);
  } catch {
    // 隐私模式下 sessionStorage 不可用，进程内标记已经够用
  }
}

/**
 * chunk 连着取不到时的最后一招：重新拿 index.html。浏览器会把失败的模块 URL 记进 module map，
 * 只有整页刷新才能指到新版 chunk。每会话至多一次，避免「新版也 404」时无限刷新。
 */
export function recoverFromOverlayLoadFailure(
  reload: () => void = () => window.location.reload()
): boolean {
  if (reloadRequested) return false;
  let alreadyReloaded = false;
  try {
    alreadyReloaded = globalThis.sessionStorage?.getItem(RELOAD_GUARD_KEY) === '1';
    globalThis.sessionStorage?.setItem(RELOAD_GUARD_KEY, '1');
  } catch {
    // 隐私模式下 sessionStorage 不可用，退回进程内标记
  }
  reloadRequested = true;
  if (alreadyReloaded) return false;
  reload();
  return true;
}

export function useOverlayModule<M>(loader: OverlayLoader<M>, urgent: boolean): M | null {
  const [module, setModule] = useState<M | null>(() => loader.peek());
  const [failures, setFailures] = useState(0);

  useEffect(() => {
    if (module) return;
    if (failures > MAX_OVERLAY_LOAD_RETRIES) {
      if (urgent) recoverFromOverlayLoadFailure();
      return;
    }
    let cancelled = false;
    void loader.load().then(
      (next) => {
        if (!cancelled) setModule(() => next);
      },
      () => {
        if (!cancelled) setFailures((count) => count + 1);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [loader, module, urgent, failures]);

  return module;
}

export interface OverlayGate<M> {
  impl: M | null;
  /** 触发器被指到/聚焦：把加载提前，但不代表用户要打开 */
  requestLoad: () => void;
  /** 触发器被按下：实现到货后直接以打开态挂载 */
  requestOpen: () => void;
}

export interface OverlayGateResult<M> {
  gate: OverlayGate<M>;
  /** 实现尚未到货时按下了触发器，挂载时要补上这一次打开 */
  forceOpen: boolean;
}

export function useOverlayGate<M>(
  loader: OverlayLoader<M>,
  openByProps: boolean
): OverlayGateResult<M> {
  const [requested, setRequested] = useState<'none' | 'load' | 'open'>('none');
  const impl = useOverlayModule(loader, openByProps || requested !== 'none');
  const gate = useMemo<OverlayGate<M>>(
    () => ({
      impl,
      requestLoad: () => setRequested((current) => (current === 'none' ? 'load' : current)),
      requestOpen: () => setRequested('open'),
    }),
    [impl]
  );
  return { gate, forceOpen: requested === 'open' };
}

/**
 * 弹层内部件的转发壳：实现未到货时渲染 null（这些部件只在弹层打开后才出现，
 * base-ui 侧同样不会在闭合态挂载 Portal / Popup），到货后原样转发 props。
 */
export function createOverlayPart<M, K extends keyof M>(
  useImpl: () => M | null,
  name: K
): M[K] extends ComponentType<infer P> ? ComponentType<P> : never {
  function OverlayPart(props: Record<string, unknown>) {
    const impl = useImpl();
    if (!impl) return null;
    const Component = impl[name] as ComponentType<Record<string, unknown>>;
    return <Component {...props} />;
  }
  OverlayPart.displayName = String(name);
  return OverlayPart as never;
}

/**
 * 实现未到货时 Root 直接渲染 children（与 base-ui 闭合态一致：Portal/Popup 不挂载，
 * 其余子节点照常）。children 为 payload 渲染函数时没有可传的 payload，只能先不渲染。
 */
export function overlayClosedChildren(children: unknown): ReactNode {
  return typeof children === 'function' ? null : (children as ReactNode);
}

/** 丢掉 base-ui 触发器的非 DOM 属性；`render` 已由 useRender 单独接手 */
export function stripTriggerProps(props: Record<string, unknown>): Record<string, unknown> {
  const {
    delay: _delay,
    closeDelay: _closeDelay,
    handle: _handle,
    payload: _payload,
    nativeButton: _nativeButton,
    openOnHover: _openOnHover,
    render,
    disabled,
    ...rest
  } = props;
  // render 为自定义元素时 disabled 未必是合法 DOM 属性（base-ui 侧由 useButton 归一化）
  if (render === undefined && disabled !== undefined) return { ...rest, disabled };
  return rest;
}

type Handler = ((event: never) => void) | undefined;

function chain(theirs: unknown, ours: () => void): (event: never) => void {
  return (event: never) => {
    ours();
    (theirs as Handler)?.(event);
  };
}

const OPEN_KEYS = new Set(['Enter', ' ', 'ArrowDown', 'ArrowUp']);

export interface OverlayTriggerProps {
  /** 与实现侧一致的 data-slot，e2e / 单测按它定位 */
  slot: string;
  /** 各族触发器的 render state 泛型互不兼容，这里只透传给 useRender，不参与类型推导 */
  render?: unknown;
  props: Record<string, unknown>;
  /** 指到/聚焦：提前加载 */
  onActivate: () => void;
  /** 按下：加载完直接打开；tooltip 这类没有「按下即开」语义的不传 */
  onOpen?: () => void;
}

/**
 * 实现到货前的触发器占位：用 base-ui 自己的 `useRender` 渲染，`render` / `className` /
 * `data-slot` 与真实触发器逐字一致，闭合态的 DOM 不会因为懒加载而变形或抖动。
 */
export function OverlayTrigger({
  slot,
  render,
  props,
  onActivate,
  onOpen,
}: OverlayTriggerProps): ReactElement {
  const rest = stripTriggerProps(props);
  // data-slot 在前、调用方 props 在后：实现侧就是 `<Primitive data-slot="…" {...props} />`，
  // 侧栏菜单按钮这类会用自己的 slot 盖掉默认值，占位不能反过来把它盖回去。
  const elementProps: Record<string, unknown> = {
    'data-slot': slot,
    ...rest,
    onPointerEnter: chain(rest.onPointerEnter, onActivate),
    onFocus: chain(rest.onFocus, onActivate),
    onPointerDown: chain(rest.onPointerDown, onOpen ?? onActivate),
  };
  if (onOpen) {
    elementProps.onKeyDown = (event: { key: string }) => {
      if (OPEN_KEYS.has(event.key)) onOpen();
      (rest.onKeyDown as Handler)?.(event as never);
    };
  }
  return useRender({
    defaultTagName: 'button',
    render: render as useRender.RenderProp,
    props: elementProps,
  });
}
