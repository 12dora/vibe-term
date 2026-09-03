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
// 显式 loader（失败不缓存）+ 有限次就地重试 + 兜底整页刷新（每会话至多一次，杜绝刷新循环）+
// 刷新也用尽时的原生 `<dialog>` 兜底面板（见 `OverlayLoadFallback`）。

import { useRender } from '@base-ui/react/use-render';
import {
  type ComponentType,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Button } from './components/button';

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

/** 'load' 继续就地重试；'wait' 失败但没人在等，什么都不做；'escalate' 用户在等，走刷新/兜底面板 */
export type OverlayLoadStep = 'load' | 'wait' | 'escalate';

export function planOverlayLoad(failures: number, urgent: boolean): OverlayLoadStep {
  if (failures <= MAX_OVERLAY_LOAD_RETRIES) return 'load';
  return urgent ? 'escalate' : 'wait';
}

export interface OverlayModuleState<M> {
  impl: M | null;
  /** 就地重试与整页刷新都用尽了：受控弹层不能再静默渲染 null，得给用户一个出口 */
  unavailable: boolean;
  /** 重新走一轮「重试 → 刷新兜底」 */
  retry: () => void;
}

export function useOverlayModule<M>(
  loader: OverlayLoader<M>,
  urgent: boolean
): OverlayModuleState<M> {
  const [module, setModule] = useState<M | null>(() => loader.peek());
  const [failures, setFailures] = useState(0);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (module) return;
    const step = planOverlayLoad(failures, urgent);
    if (step !== 'load') {
      // 本会话已经刷过一次（刷新兜底用尽），再刷也只会拿到同一个 404：把失败暴露给调用方
      if (step === 'escalate' && !recoverFromOverlayLoadFailure()) setUnavailable(true);
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

  const retry = useCallback(() => {
    setUnavailable(false);
    setFailures(0);
  }, []);

  return { impl: module, unavailable, retry };
}

export interface OverlayGate<M> {
  impl: M | null;
  /** 实现永远到不了：调用方渲染兜底面板 */
  unavailable: boolean;
  /** 触发器被指到/聚焦：把加载提前，但不代表用户要打开 */
  requestLoad: () => void;
  /** 触发器被按下：实现到货后直接以打开态挂载 */
  requestOpen: () => void;
  retry: () => void;
}

export interface OverlayGateResult<M> {
  gate: OverlayGate<M>;
  /** 实现尚未到货时按下了触发器，挂载时要补上这一次打开 */
  forceOpen: boolean;
  /** 用户确实要打开，但实现永远到不了：渲染兜底面板 */
  showFallback: boolean;
}

export function useOverlayGate<M>(
  loader: OverlayLoader<M>,
  openByProps: boolean
): OverlayGateResult<M> {
  const [requested, setRequested] = useState<'none' | 'load' | 'open'>('none');
  const { impl, unavailable, retry } = useOverlayModule(
    loader,
    openByProps || requested !== 'none'
  );
  const gate = useMemo<OverlayGate<M>>(
    () => ({
      impl,
      unavailable,
      retry,
      requestLoad: () => setRequested((current) => (current === 'none' ? 'load' : current)),
      requestOpen: () => setRequested('open'),
    }),
    [impl, unavailable, retry]
  );
  const forceOpen = requested === 'open';
  return { gate, forceOpen, showFallback: unavailable && (openByProps || forceOpen) };
}

export interface OverlayLoadFallbackProps {
  onRetry: () => void;
  onReload?: () => void;
}

/**
 * 弹层 chunk 彻底取不到时的出口：不碰 base-ui，用原生 `<dialog>` 上顶层——祖先的 transform
 * （键盘避让会给 SidebarInset 加）不会把它拽回文档流里。文案不走 i18n：packages/ui 不依赖
 * i18n，为一个极端兜底引一层依赖不划算。
 */
export function OverlayLoadFallback({
  onRetry,
  onReload = () => window.location.reload(),
}: OverlayLoadFallbackProps): ReactElement {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || element.open) return;
    // 兜底面板本身绝不能再抛：showModal 在个别状态下会抛 InvalidStateError
    try {
      element.showModal?.();
    } catch {
      element.setAttribute('open', '');
    }
    return () => {
      if (element.open) element.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      data-slot="overlay-load-fallback"
      className="bg-background text-foreground ring-foreground/10 m-auto w-full max-w-sm rounded-xl p-4 text-sm ring-1 backdrop:bg-black/40"
    >
      <p className="mb-3">This dialog failed to load. Check your connection and try again.</p>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onReload}>
          Reload page
        </Button>
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </dialog>
  );
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

export interface TriggerActivity {
  /** 渲染过占位才说明经历了替换；一上来就是实现的触发器什么都不用补 */
  placeholder: boolean;
  focused: boolean;
  hovered: boolean;
}

export interface TriggerEnvironment {
  /** 焦点是否掉到了 body/无处：占位被移除时浏览器不派发 blur，只能这样判断是不是被替换弄丢的 */
  focusLoose: boolean;
  /** 指针此刻是否仍停在新节点上 */
  pointerInside: boolean;
}

export interface TriggerHandoffPlan {
  focus: boolean;
  hover: boolean;
}

/**
 * 占位换成实现时 DOM 节点必然重建（React 无法跨组件类型保留同一个宿主节点），
 * 焦点会掉回 body、hover 也不会重新派发。这里决定要补什么：
 * 焦点只在「占位曾持有焦点且当前焦点确实无主」时抢回来，避免抢走用户已经移走的焦点。
 */
export function planTriggerHandoff(
  activity: TriggerActivity,
  env: TriggerEnvironment
): TriggerHandoffPlan {
  if (!activity.placeholder) return { focus: false, hover: false };
  return {
    focus: activity.focused && env.focusLoose,
    hover: activity.hovered || env.pointerInside,
  };
}

export function readTriggerEnvironment(node: HTMLElement): TriggerEnvironment {
  const doc = node.ownerDocument as Document | undefined;
  const active = doc?.activeElement ?? null;
  return {
    focusLoose: active === null || active === doc?.body,
    pointerInside: typeof node.matches === 'function' && node.matches(':hover'),
  };
}

export interface TriggerHandoffEffects {
  focus: (node: HTMLElement) => void;
  replayHover: (node: HTMLElement) => void;
  schedule: (task: () => void) => void;
}

// pointerover / mouseover / mousemove 走 React 的根委托（onPointerEnter / onMouseEnter /
// onMouseMove 由它们合成），mouseenter 直达 base-ui 在触发器上挂的原生监听。
// 补发前再确认一次指针仍压在节点上：替换后的这一帧里用户可能已经移开，
// 那时候补一发 mouseenter 会弹出一个没人能关掉的气泡。
function replayHover(node: HTMLElement): void {
  const view = node.ownerDocument?.defaultView;
  if (!view) return;
  if (typeof node.matches === 'function' && !node.matches(':hover')) return;
  const shared: MouseEventInit = { bubbles: true, cancelable: true, view, relatedTarget: null };
  if (typeof view.PointerEvent === 'function') {
    const pointer: PointerEventInit = { ...shared, pointerType: 'mouse', isPrimary: true };
    node.dispatchEvent(new view.PointerEvent('pointerover', pointer));
    node.dispatchEvent(new view.PointerEvent('pointerenter', { ...pointer, bubbles: false }));
  }
  node.dispatchEvent(new view.MouseEvent('mouseover', shared));
  node.dispatchEvent(new view.MouseEvent('mouseenter', { ...shared, bubbles: false }));
  node.dispatchEvent(new view.MouseEvent('mousemove', shared));
}

export const domTriggerHandoffEffects: TriggerHandoffEffects = {
  focus: (node) => node.focus({ preventScroll: true }),
  replayHover,
  // 等一帧再补发：base-ui 的 hover 监听是 passive effect 里 addEventListener 到「已注册的
  // trigger 元素」上的，而元素注册本身要先经过一次 ref → store → 重渲染。抢在那之前派发
  // mouseenter 没人接。同一帧里浏览器也已经重新命中测试过，`:hover` 才可信。
  schedule: (task) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => task());
    else setTimeout(task, 0);
  },
};

export function applyTriggerHandoff(
  node: HTMLElement,
  plan: TriggerHandoffPlan,
  effects: TriggerHandoffEffects = domTriggerHandoffEffects
): void {
  if (plan.focus) effects.focus(node);
  if (!plan.hover) return;
  effects.schedule(() => {
    if (node.isConnected) effects.replayHover(node);
  });
}

export interface TriggerHandoff {
  /** 占位与实现共用一个 id：替换前后辅助技术看到的仍是同一个触发器 */
  id: string;
  /** 占位渲染时记账 */
  markPlaceholder: () => void;
  record: (patch: Partial<Omit<TriggerActivity, 'placeholder'>>) => void;
  /** 挂到实现侧触发器上：新节点接手同一位置后补回焦点与悬停 */
  adopt: (node: HTMLElement | null) => void;
}

export function useTriggerHandoff(id?: string): TriggerHandoff {
  const generatedId = useId();
  const activity = useRef<TriggerActivity>({
    placeholder: false,
    focused: false,
    hovered: false,
  });
  const adopted = useRef(false);

  return useMemo<TriggerHandoff>(
    () => ({
      id: id ?? generatedId,
      markPlaceholder: () => {
        activity.current.placeholder = true;
      },
      record: (patch) => {
        activity.current = { ...activity.current, ...patch };
      },
      adopt: (node) => {
        if (!node || adopted.current) return;
        adopted.current = true;
        const plan = planTriggerHandoff(activity.current, readTriggerEnvironment(node));
        activity.current = { placeholder: false, focused: false, hovered: false };
        applyTriggerHandoff(node, plan);
      },
    }),
    [id, generatedId]
  );
}

const ENTER_SPACE = ['Enter', ' '];

export interface OverlayTriggerSemantics {
  /** base-ui 在客户端注入的 aria-haspopup；tooltip 触发器没有 popup 语义 */
  haspopup?: 'dialog' | 'menu';
  /** 触发器是否走 base-ui 的 useButton（tabIndex / role / data-disabled 与之对齐） */
  button: boolean;
  /** 实现未到货时哪些键算「按下即开」：方向键只属于 menu，dialog 系是纯按钮语义 */
  openKeys: readonly string[];
}

export const DIALOG_TRIGGER_SEMANTICS: OverlayTriggerSemantics = {
  haspopup: 'dialog',
  button: true,
  openKeys: ENTER_SPACE,
};

export const MENU_TRIGGER_SEMANTICS: OverlayTriggerSemantics = {
  haspopup: 'menu',
  button: true,
  openKeys: [...ENTER_SPACE, 'ArrowDown', 'ArrowUp'],
};

export const TOOLTIP_TRIGGER_SEMANTICS: OverlayTriggerSemantics = {
  button: false,
  openKeys: [],
};

export interface OverlayTriggerProps {
  /** 与实现侧一致的 data-slot，e2e / 单测按它定位 */
  slot: string;
  semantics: OverlayTriggerSemantics;
  handoff: TriggerHandoff;
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
 * `data-slot` 与真实触发器逐字一致，闭合态的 DOM 不会因为懒加载而变形或抖动；
 * base-ui 在客户端补的 `aria-haspopup` / `aria-expanded` / `tabIndex` / `id` 也一并补齐。
 */
export function OverlayTrigger({
  slot,
  semantics,
  handoff,
  render,
  props,
  onActivate,
  onOpen,
}: OverlayTriggerProps): ReactElement {
  handoff.markPlaceholder();
  const rest = stripTriggerProps(props);
  // data-slot 在前、调用方 props 在后：实现侧就是 `<Primitive data-slot="…" {...props} />`，
  // 侧栏菜单按钮这类会用自己的 slot 盖掉默认值，占位不能反过来把它盖回去。
  const elementProps: Record<string, unknown> = {
    'data-slot': slot,
    id: handoff.id,
    ...(semantics.haspopup
      ? { 'aria-haspopup': semantics.haspopup, 'aria-expanded': 'false' }
      : null),
    ...(semantics.button ? { tabIndex: 0 } : null),
    ...(semantics.button && props.nativeButton === false ? { role: 'button' } : null),
    ...(semantics.button && props.disabled === true ? { 'data-disabled': '' } : null),
    ...rest,
    onPointerEnter: chain(rest.onPointerEnter, () => {
      handoff.record({ hovered: true });
      onActivate();
    }),
    onPointerLeave: chain(rest.onPointerLeave, () => handoff.record({ hovered: false })),
    onFocus: chain(rest.onFocus, () => {
      handoff.record({ focused: true });
      onActivate();
    }),
    onBlur: chain(rest.onBlur, () => handoff.record({ focused: false })),
    onPointerDown: chain(rest.onPointerDown, onOpen ?? onActivate),
  };
  if (onOpen && semantics.openKeys.length > 0) {
    elementProps.onKeyDown = (event: { key: string }) => {
      if (semantics.openKeys.includes(event.key)) onOpen();
      (rest.onKeyDown as Handler)?.(event as never);
    };
  }
  return useRender({
    defaultTagName: 'button',
    render: render as useRender.RenderProp,
    props: elementProps,
  });
}
