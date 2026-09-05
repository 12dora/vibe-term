// 回放用的只读终端：与终端预览同一套建法（createTerminalController + FitAddon，字体与配色取自
// UI 设置），但不接 onData——回放里的输入只作标记展示，绝不写回终端。
//
// 尺寸由录像决定：checkpoint / resize 条目带着当时的行列数，来一条就 resize 一次；
// 录像没给尺寸时（老日志或只有输出）退回按容器 fit。
//
// 录像的行列数几乎总大于 22rem 的回放窗（120×40、200×60 都很常见），所以建完终端就打开
// 平移视口：内容表面按录制尺寸完整绘制，容器只负责裁剪 + 双向滚动（与跟随者终端同一套
// 机制）。不开的话 Ghostty 视口是 overflow:hidden，底部命令和右侧内容根本看不到。

import { useUIStore } from '@tmex/stores/react';
import { loadTerminalFonts, resolveFontStack, resolveTerminalTheme } from '@tmex/theme';
import { FitAddon, createTerminalController } from 'ghostty-terminal';
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Controller = Awaited<ReturnType<typeof createTerminalController>>;

export interface ReplayTerminalHandle {
  write: (data: Uint8Array) => void;
  resize: (cols: number, rows: number) => void;
  reset: () => void;
  fit: () => void;
}

export interface ReplayTerminalState {
  handle: ReplayTerminalHandle;
  /** 终端实例已就绪：回放要等它才开始喂数据。 */
  ready: boolean;
  background: string;
}

const REPLAY_SCROLLBACK = 2000;

interface ReplayViewportTarget {
  setViewportPan(enabled: boolean): void;
}

interface ReplayFitTarget {
  fit(): void;
}

interface ReplayMountLike {
  querySelector(selector: string): { style?: { touchAction: string } } | null;
}

/** 平移视口的容器（`applyPanStyles` 打的标记）。 */
const PAN_VIEWPORT_SELECTOR = '[data-pan-viewport="true"]';

/**
 * 建完终端后的视口配置：先按容器 fit 出一个可用的缺省尺寸（没有 resize 条目的老日志只有它），
 * 再打开平移视口——顺序不能反，fit 要在 overflow 还是 hidden 时量，量到的才是纯容器尺寸。
 *
 * 平移视口默认 `touch-action: none`，因为在线终端的平移由手势状态机以像素驱动，交给原生
 * 触摸滚动会打架。回放没有那套手势（只读终端不走 terminal-ui 的 Terminal 组件），所以把
 * touch-action 交还给浏览器，手机上才能把画面拖到右下角。
 */
export function applyReplayViewport(
  term: ReplayViewportTarget,
  fit: ReplayFitTarget,
  mount?: ReplayMountLike | null
): void {
  fit.fit();
  term.setViewportPan(true);
  const style = mount?.querySelector(PAN_VIEWPORT_SELECTOR)?.style;
  if (style) style.touchAction = 'auto';
}

export function useReplayTerminal(mountRef: RefObject<HTMLDivElement | null>): ReplayTerminalState {
  const fontId = useUIStore((state) => state.terminalFontId);
  const fontSize = useUIStore((state) => state.terminalFontSize);
  const lineHeight = useUIStore((state) => state.terminalLineHeight);
  const theme = useUIStore((state) => state.theme);
  const themePreset = useUIStore((state) => state.themePreset);
  const terminalTheme = useMemo(
    () => resolveTerminalTheme(theme, themePreset),
    [theme, themePreset]
  );

  const termRef = useRef<Controller | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [ready, setReady] = useState(false);
  const themeRef = useRef(terminalTheme);
  themeRef.current = terminalTheme;

  useEffect(() => {
    let cancelled = false;
    let term: Controller | null = null;
    void (async () => {
      try {
        await loadTerminalFonts(fontId, fontSize);
      } catch {
        // 字体加载失败不挡回放：退回系统等宽字体继续建终端
      }
      const mount = mountRef.current;
      if (cancelled || !mount) return;
      try {
        term = await createTerminalController({
          fontFamily: resolveFontStack(fontId),
          fontSize,
          lineHeight,
          scrollback: REPLAY_SCROLLBACK,
          theme: themeRef.current,
          disableStdin: true,
        });
      } catch {
        return;
      }
      if (cancelled) {
        term.dispose();
        return;
      }
      try {
        term.open(mount);
      } catch {
        term.dispose();
        term = null;
        return;
      }
      const fit = new FitAddon();
      term.loadAddon(fit);
      applyReplayViewport(term, fit, mount);
      termRef.current = term;
      fitRef.current = fit;
      setReady(true);
    })();

    return () => {
      cancelled = true;
      setReady(false);
      termRef.current = null;
      fitRef.current = null;
      term?.dispose();
    };
  }, [fontId, fontSize, lineHeight, mountRef]);

  useEffect(() => {
    termRef.current?.setTheme(terminalTheme);
  }, [terminalTheme]);

  const write = useCallback((data: Uint8Array) => {
    if (data.length > 0) termRef.current?.write(data);
  }, []);
  const resize = useCallback((cols: number, rows: number) => {
    termRef.current?.resize(cols, rows);
  }, []);
  const reset = useCallback(() => {
    termRef.current?.reset();
  }, []);
  const fit = useCallback(() => {
    fitRef.current?.fit();
  }, []);

  const handle = useMemo<ReplayTerminalHandle>(
    () => ({ write, resize, reset, fit }),
    [write, resize, reset, fit]
  );

  return { handle, ready, background: terminalTheme.background };
}
