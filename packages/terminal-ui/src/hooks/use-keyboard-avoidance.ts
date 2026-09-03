import type { KeyboardBehaviorMode } from '@tmex/stores';
import { useEffect, useState } from 'react';
import { FollowLoopScheduler } from '../utils/follow-loop';
import { AppliedTransformReader, ShortcutStripTracker } from '../utils/keyboard-avoidance-dom';
import { readActiveCursorRect } from '../utils/keyboard-cursor-bridge';
import { ShortcutLiftWriter } from '../utils/shortcut-lift';
import {
  computeCursorFollowOffset,
  computeVirtualKeyboardOffset,
  needsManualKeyboardAvoidance,
} from '../utils/virtualKeyboard';

// 手机虚拟键盘避让结果，由 MainInset 应用到 <main>（issue #27）。
// transform=整页上移（lift / follow）；height=收缩可用高度触发终端 resize（resize）。
export type KeyboardAvoidance =
  | { strategy: 'none' }
  | { strategy: 'transform'; offset: number }
  | { strategy: 'height'; height: number };

const NONE: KeyboardAvoidance = { strategy: 'none' };
// 光标对齐模式下，光标底沿与键盘顶之间保留的间距（px）
const CURSOR_FOLLOW_MARGIN = 8;
// resize 模式的可用高度（innerHeight - inset）下限：低于此值时不再收缩 <main>，改为退化
// 为整页上移，避免 header + 快捷键栏等固定开销把终端压没（横屏/键盘占屏比高时）。
const MIN_RESIZE_AVAILABLE_PX = 60;
// <main>（SidebarInset）的 data-slot，用于读取其当前实际 translateY
const MAIN_SLOT_SELECTOR = '[data-slot="sidebar-inset"]';
// direct 模式终端下方的快捷键栏；follow 模式键盘弹起时让它浮到键盘正上方
const SHORTCUT_BAR_SELECTOR = '.terminal-shortcuts-strip';
// 承载快捷键栏浮动位移的外层：--tmex-kb-shortcut-lift 的唯一消费者
const SHORTCUT_FLOAT_SELECTOR = '.kb-floating-shortcuts';
// 快捷键栏额外上移量的 CSS 变量（= inset - offset）：本 hook 写、ShortcutsBar 用其做 translateY。
// 叠加 <main> 已有的 -offset 后总位移恰为 -inset，贴键盘顶。
const SHORTCUT_LIFT_VAR = '--tmex-kb-shortcut-lift';

function sameAvoidance(a: KeyboardAvoidance, b: KeyboardAvoidance): boolean {
  if (a.strategy !== b.strategy) {
    return false;
  }
  if (a.strategy === 'transform' && b.strategy === 'transform') {
    return Math.abs(a.offset - b.offset) < 1;
  }
  if (a.strategy === 'height' && b.strategy === 'height') {
    return Math.abs(a.height - b.height) < 1;
  }
  return true; // 同为 none
}

// 按 mode 计算手机虚拟键盘的页面避让策略。
// - lift：整页上移键盘高度（0.12.0 现状）。
// - resize：把 <main> 高度收到键盘上方可用高度，触发终端既有 ResizeObserver → resize。
// - follow：按光标位置上移使光标贴键盘顶；键盘打开期间 RAF 轮询（光标移动不发 viewport
//   事件），测量收敛后退到 FOLLOW_IDLE_PROBE_MS 的低频探测。拿不到光标（终端未聚焦/编辑器/
//   光标隐藏）时回退到整页上移。
export function useKeyboardAvoidance(
  disabled: boolean,
  mode: KeyboardBehaviorMode
): KeyboardAvoidance {
  const [avoidance, setAvoidance] = useState<KeyboardAvoidance>(NONE);

  useEffect(() => {
    if (!needsManualKeyboardAvoidance()) {
      return;
    }
    const viewport = window.visualViewport;
    if (!viewport) {
      return;
    }

    let eventRaf: number | null = null;
    let current: KeyboardAvoidance = NONE;
    const lift = new ShortcutLiftWriter(SHORTCUT_LIFT_VAR);
    // 读 DOM 实测而非追踪目标值：光标矩形取的是"已应用位移后"的坐标，配上一个尚未落到
    // DOM 的目标值会双重补偿、来回震荡，对 CSS 过渡与 React 提交时序都不收敛。
    const mainTransform = new AppliedTransformReader(MAIN_SLOT_SELECTOR);
    const strip = new ShortcutStripTracker(SHORTCUT_BAR_SELECTOR, () => scheduleCompute());
    const follow = new FollowLoopScheduler({
      now: () => Date.now(),
      requestFrame: (fn) => window.requestAnimationFrame(fn),
      cancelFrame: (handle) => window.cancelAnimationFrame(handle),
      requestIdle: (fn, ms) => setTimeout(fn, ms),
      cancelIdle: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      measure: () => compute(),
      probe: () => {
        const rect = readActiveCursorRect();
        return probeSignature(rect ? rect.bottom : null, readInset());
      },
    });

    const commit = (next: KeyboardAvoidance) => {
      // 仅在实质变化时 setState，避免 follow RAF 每帧 re-render
      if (sameAvoidance(current, next)) {
        return;
      }
      current = next;
      setAvoidance(next);
    };

    // 变量只写到快捷键栏所在的浮层上：写 documentElement 会让整篇文档的样式失效。
    const applyLift = (px: number, element: HTMLElement | null) => {
      lift.set(px, element?.closest<HTMLElement>(SHORTCUT_FLOAT_SELECTOR) ?? null);
    };

    // 把快捷键栏底沿对齐到键盘顶：量它当前底沿、把到键盘顶的差值补进 lift（测量驱动，
    // 自动含终端底部 padding，避免靠推导留下偏差）。逐帧调用，迭代收敛——稳态下
    // strip 底沿恰为键盘顶，光标据 margin 停在它上方。
    const alignShortcutToKeyboardTop = (element: HTMLElement | null, inset: number) => {
      if (!element) {
        applyLift(0, null);
        return;
      }
      const stripBottom = element.getBoundingClientRect().bottom;
      const keyboardTop = window.innerHeight - inset;
      applyLift(lift.applied + (stripBottom - keyboardTop), element);
    };

    // 当前键盘遮挡高度；不在避让容器内 / 被 disabled 时为 0
    const readInset = (): number => {
      if (disabled) {
        return 0;
      }
      const active = document.activeElement;
      const shouldAvoid =
        active instanceof Element && active.closest('[data-virtual-keyboard-avoid]') !== null;
      if (!shouldAvoid) {
        return 0;
      }
      return computeVirtualKeyboardOffset({
        windowInnerHeight: window.innerHeight,
        viewportHeight: viewport.height,
        viewportOffsetTop: viewport.offsetTop,
        viewportScale: viewport.scale,
      });
    };

    const compute = () => {
      const inset = readInset();
      if (inset <= 0) {
        applyLift(0, strip.resolve());
        commit(NONE);
        follow.stop();
        return;
      }

      if (mode === 'resize') {
        applyLift(0, strip.resolve());
        const available = window.innerHeight - inset;
        if (available >= MIN_RESIZE_AVAILABLE_PX) {
          commit({ strategy: 'height', height: available });
        } else {
          // 键盘过高，收缩到该高度会把终端压没——退化为整页上移，保住终端可用高度
          commit({ strategy: 'transform', offset: inset });
        }
        follow.stop();
        return;
      }

      if (mode === 'follow') {
        const rect = readActiveCursorRect();
        if (rect) {
          // 终端聚焦（direct 输入）：快捷键栏浮到键盘正上方，光标预留其高度停在浮条之上
          const stripEl = strip.resolve();
          const barHeight = strip.heightOf(stripEl);
          const offset = computeCursorFollowOffset({
            cursorBottomClientY: rect.bottom,
            appliedOffset: mainTransform.read(),
            windowInnerHeight: window.innerHeight,
            inset,
            margin: CURSOR_FOLLOW_MARGIN + barHeight,
            // 允许多抬一个快捷键栏高度，使光标即便在终端最底行也能停到浮条之上；
            // 多抬露出的空白被浮动快捷键栏盖住，不露白。
            maxOffset: inset + barHeight,
          });
          commit(offset > 0 ? { strategy: 'transform', offset } : NONE);
          // 快捷键栏底沿对齐到真实键盘顶（测量驱动，自动含终端底部 padding）
          alignShortcutToKeyboardTop(stripEl, inset);
        } else {
          // 非终端聚焦（编辑器等）：整页上移键盘高度，快捷键栏不单独浮动
          applyLift(0, strip.resolve());
          commit({ strategy: 'transform', offset: inset });
        }
        paceFollowLoop(rect ? rect.bottom : null, inset);
        return;
      }

      // lift（默认/兜底）
      applyLift(0, strip.resolve());
      commit({ strategy: 'transform', offset: inset });
      follow.stop();
    };

    const probeSignature = (cursorBottom: number | null, inset: number) =>
      `${cursorBottom === null ? 'none' : Math.round(cursorBottom)}:${inset}`;

    // 这一帧的测量与上几帧一致就判定收敛，把 60 Hz 的强制布局退到低频探测。
    const paceFollowLoop = (cursorBottom: number | null, inset: number) => {
      const applied = current.strategy === 'transform' ? current.offset : 0;
      const probe = probeSignature(cursorBottom, inset);
      follow.pace(`${current.strategy}:${applied}:${lift.applied}:${probe}`, probe);
    };

    // 事件驱动的重算：任何可能让测量失效的事件都把收敛判定清零，回到逐帧跟随。
    const scheduleCompute = () => {
      follow.invalidate();
      if (eventRaf === null) {
        eventRaf = window.requestAnimationFrame(() => {
          eventRaf = null;
          compute();
        });
      }
    };

    compute();

    viewport.addEventListener('resize', scheduleCompute);
    viewport.addEventListener('scroll', scheduleCompute);
    window.addEventListener('resize', scheduleCompute);
    window.addEventListener('orientationchange', scheduleCompute);
    document.addEventListener('focusin', scheduleCompute);
    document.addEventListener('focusout', scheduleCompute);
    // 输入是光标移动的源头：按键 / IME 上屏 / 点选落点都要把循环拉回逐帧。
    document.addEventListener('keydown', scheduleCompute, true);
    document.addEventListener('input', scheduleCompute, true);
    document.addEventListener('compositionend', scheduleCompute, true);
    document.addEventListener('pointerup', scheduleCompute, true);

    return () => {
      viewport.removeEventListener('resize', scheduleCompute);
      viewport.removeEventListener('scroll', scheduleCompute);
      window.removeEventListener('resize', scheduleCompute);
      window.removeEventListener('orientationchange', scheduleCompute);
      document.removeEventListener('focusin', scheduleCompute);
      document.removeEventListener('focusout', scheduleCompute);
      document.removeEventListener('keydown', scheduleCompute, true);
      document.removeEventListener('input', scheduleCompute, true);
      document.removeEventListener('compositionend', scheduleCompute, true);
      document.removeEventListener('pointerup', scheduleCompute, true);
      if (eventRaf !== null) {
        window.cancelAnimationFrame(eventRaf);
      }
      follow.stop();
      strip.disconnect();
      lift.dispose();
    };
  }, [disabled, mode]);

  return avoidance;
}
