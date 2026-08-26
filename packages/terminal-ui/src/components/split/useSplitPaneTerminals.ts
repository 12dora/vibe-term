// 分屏内各 Terminal 实例的登记与联动：尺寸跟随 layout、焦点转发、非焦点 pane 首屏 history。

import { useRuntime, useTmuxStore } from '@tmex/stores/react';
import { type RefObject, useCallback, useEffect, useRef } from 'react';
import type { SplitLayoutGeometry } from '../splitLayoutGeometry';
import type { TerminalRef } from '../types';

export interface SplitPaneTerminalsInput {
  deviceId: string;
  windowId: string;
  focusedPaneId: string;
  inputMode: 'direct' | 'editor';
  knownPaneIdsKey: string;
  paneSizes: string;
  geometryRef: RefObject<SplitLayoutGeometry | null>;
  focusedTerminalRef: (ref: TerminalRef | null) => void;
}

export interface SplitPaneTerminals {
  /** 每个 pane 的 Terminal ref 登记入口（引用稳定，避免每次渲染重挂 ref） */
  registerTerminal: (paneId: string, ref: TerminalRef | null) => void;
  /** 任一已就绪实例的 cell 尺寸，优先取焦点实例 */
  getFocusedCellSize: () => { width: number; height: number } | null;
}

export function useSplitPaneTerminals({
  deviceId,
  windowId,
  focusedPaneId,
  inputMode,
  knownPaneIdsKey,
  paneSizes,
  geometryRef,
  focusedTerminalRef,
}: SplitPaneTerminalsInput): SplitPaneTerminals {
  const terminalRefs = useRef(new Map<string, TerminalRef | null>());
  const runtime = useRuntime();
  const fetchPaneHistory = useTmuxStore((state) => state.fetchPaneHistory);

  const focusedPaneIdRef = useRef(focusedPaneId);
  focusedPaneIdRef.current = focusedPaneId;
  const focusedTerminalRefFn = useRef(focusedTerminalRef);
  focusedTerminalRefFn.current = focusedTerminalRef;

  // 引用稳定：ref 回调每渲染换新会让 React 反复 detach/attach，
  // 期间外部 terminalRef 会瞬时变 null，并触发无谓的 resize
  const registerTerminal = useCallback(
    (paneId: string, ref: TerminalRef | null) => {
      if (ref) {
        terminalRefs.current.set(paneId, ref);
        const pane = geometryRef.current?.panes.find((p) => p.paneId === paneId);
        if (pane) {
          ref.resize(pane.cols, pane.rows);
        }
      } else {
        terminalRefs.current.delete(paneId);
      }
      if (paneId === focusedPaneIdRef.current) {
        focusedTerminalRefFn.current(ref);
      }
    },
    [geometryRef]
  );

  const getFocusedCellSize = useCallback((): { width: number; height: number } | null => {
    for (const paneId of [focusedPaneId, ...terminalRefs.current.keys()]) {
      const cell = terminalRefs.current.get(paneId)?.getCellSize();
      if (cell) return cell;
    }
    return null;
  }, [focusedPaneId]);

  // 非焦点 pane 首屏：fetch history（焦点 pane 的内容来自 select 流程）；
  // 每个 pane 只 fetch 一次，window 切换时重置
  const fetchStateRef = useRef({ key: '', fetched: new Set<string>() });
  useEffect(() => {
    if (runtime.transport.capabilities.atomicScreen) return;
    const windowKey = `${deviceId}:${windowId}`;
    if (fetchStateRef.current.key !== windowKey) {
      fetchStateRef.current = { key: windowKey, fetched: new Set() };
    }
    for (const paneId of knownPaneIdsKey ? knownPaneIdsKey.split(',') : []) {
      if (fetchStateRef.current.fetched.has(paneId)) continue;
      if (paneId === focusedPaneId) continue;
      fetchStateRef.current.fetched.add(paneId);
      fetchPaneHistory(deviceId, paneId);
    }
  }, [deviceId, windowId, knownPaneIdsKey, focusedPaneId, fetchPaneHistory, runtime]);

  // 焦点变化时聚焦对应实例
  useEffect(() => {
    if (inputMode !== 'direct') return;
    const isMobileLike = window.innerWidth < 768 || 'ontouchstart' in window;
    if (isMobileLike) return;
    terminalRefs.current.get(focusedPaneId)?.getTerminal()?.focus();
  }, [focusedPaneId, inputMode]);

  // 各实例 cols/rows 跟随 tmux layout（tmux 是尺寸权威）
  // 依赖 paneSizes 而非 geometry 引用：layout 字符串抖动（A pane 输出导致光标移动）
  // 会使 geometry 引用变化但 pane 尺寸不变，此时不应触发 resize
  // biome-ignore lint/correctness/useExhaustiveDependencies: paneSizes 是触发条件，geometry 通过 ref 访问避免引用抖动
  useEffect(() => {
    const geometry = geometryRef.current;
    if (!geometry) return;
    for (const pane of geometry.panes) {
      terminalRefs.current.get(pane.paneId)?.resize(pane.cols, pane.rows);
    }
  }, [paneSizes]);

  // 焦点切换时把外部 ref 重新指到新焦点实例
  useEffect(() => {
    focusedTerminalRef(terminalRefs.current.get(focusedPaneId) ?? null);
  }, [focusedPaneId, focusedTerminalRef]);

  return { registerTerminal, getFocusedCellSize };
}
