import type { TerminalDiagnosticStage } from '../terminal-diagnostics';

export const RENDER_TARGET_CANCELLED_MESSAGE = 'terminal initialization cancelled';
export const RENDER_TARGET_HOST_MISSING_MESSAGE = 'Terminal mount is unavailable.';

export type RenderTargetStage = Extract<
  TerminalDiagnosticStage,
  'controller_failed' | 'controller_ready' | 'open_failed' | 'opened'
>;

export interface RenderTargetMount {
  className: string;
  style: { visibility: string; pointerEvents: string };
  remove(): void;
}

export interface RenderTargetDocument<Mount extends RenderTargetMount> {
  createElement(tagName: 'div'): Mount;
}

export interface RenderTargetHost<Mount extends RenderTargetMount> {
  appendChild(mount: Mount): unknown;
}

export interface RenderTargetTerminal<Mount extends RenderTargetMount> {
  open(mount: Mount): void;
  dispose(): void;
  scrollToBottom(): void;
  forceFullRepaint?(): void;
}

export interface RenderTarget<
  Mount extends RenderTargetMount,
  Terminal extends RenderTargetTerminal<Mount>,
> {
  terminal: Terminal;
  mount: Mount;
  liveOutputEndedWithCR: boolean;
  dispose(): void;
}

export interface RenderTargetDeps<
  Mount extends RenderTargetMount,
  Terminal extends RenderTargetTerminal<Mount>,
> {
  document: RenderTargetDocument<Mount>;
  createController(): Promise<Terminal>;
  isCancelled(): boolean;
  resolveHost(): RenderTargetHost<Mount> | null;
  reportStage(stage: RenderTargetStage, terminal: Terminal | null, mount: Mount | null): void;
  onDisposed(terminal: Terminal): void;
}

/** 新一代终端先挂在不可见、不吃事件的离屏 mount 上，等 activate 才换进来 */
export function createHiddenMount<Mount extends RenderTargetMount>(
  document: RenderTargetDocument<Mount>
): Mount {
  const mount = document.createElement('div');
  mount.className = 'absolute inset-0';
  mount.style.visibility = 'hidden';
  mount.style.pointerEvents = 'none';
  return mount;
}

export function activateRenderTarget<
  Mount extends RenderTargetMount,
  Terminal extends RenderTargetTerminal<Mount>,
>(target: { terminal: Terminal; mount: Mount }): void {
  target.mount.style.visibility = 'visible';
  target.mount.style.pointerEvents = 'auto';
  target.terminal.scrollToBottom();
  target.terminal.forceFullRepaint?.();
}

async function createController<
  Mount extends RenderTargetMount,
  Terminal extends RenderTargetTerminal<Mount>,
>(deps: RenderTargetDeps<Mount, Terminal>): Promise<Terminal> {
  try {
    return await deps.createController();
  } catch (error) {
    deps.reportStage('controller_failed', null, null);
    throw error;
  }
}

function openMount<Mount extends RenderTargetMount, Terminal extends RenderTargetTerminal<Mount>>(
  deps: RenderTargetDeps<Mount, Terminal>,
  terminal: Terminal,
  mount: Mount
): void {
  try {
    terminal.open(mount);
  } catch (error) {
    deps.reportStage('open_failed', terminal, mount);
    terminal.dispose();
    mount.remove();
    throw error;
  }
}

/**
 * 建立一代终端渲染目标：控制器 → 离屏 mount → open。任一步失败或期间被取消，
 * 都在抛出前把已经建立的控制器与 mount 释放干净。
 */
export async function createTerminalRenderTarget<
  Mount extends RenderTargetMount,
  Terminal extends RenderTargetTerminal<Mount>,
>(deps: RenderTargetDeps<Mount, Terminal>): Promise<RenderTarget<Mount, Terminal>> {
  const terminal = await createController(deps);
  if (deps.isCancelled()) {
    terminal.dispose();
    throw new Error(RENDER_TARGET_CANCELLED_MESSAGE);
  }

  const host = deps.resolveHost();
  if (!host) {
    terminal.dispose();
    throw new Error(RENDER_TARGET_HOST_MISSING_MESSAGE);
  }

  const mount = createHiddenMount(deps.document);
  host.appendChild(mount);
  deps.reportStage('controller_ready', terminal, mount);
  openMount(deps, terminal, mount);
  deps.reportStage('opened', terminal, mount);

  return {
    terminal,
    mount,
    liveOutputEndedWithCR: false,
    dispose() {
      deps.onDisposed(terminal);
      terminal.dispose();
      mount.remove();
    },
  };
}
