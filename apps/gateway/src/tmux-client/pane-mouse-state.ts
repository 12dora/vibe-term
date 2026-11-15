import type { ControlModeCommandQueue } from './control-mode-capture';
import type { MouseReportKind } from './mouse-sequence';
import { isTmuxPaneId } from './snapshot-format';

export type MouseTracking = 'none' | 'normal' | 'button' | 'any';

export interface PaneMouseState {
  tracking: MouseTracking;
  sgr: boolean;
  utf8: boolean;
  urxvt: boolean;
  /** false 表示还没见过 DECSET/DECRST 或 tmux 标志，tracking 不可信 */
  known: boolean;
  /** 最近一次按 tmux 标志校准的时间，未校准为 null */
  verifiedAt: number | null;
}

export interface PaneMouseFlags {
  standard: boolean;
  button: boolean;
  all: boolean;
  sgr: boolean;
  currentCommand: string | null;
}

/** 前台是这些交互 shell 时不会请求鼠标上报：残留的模式来自异常退出的 TUI */
export const PLAIN_SHELL_COMMANDS: readonly string[] = [
  'bash',
  'zsh',
  'fish',
  'sh',
  'dash',
  'ksh',
  'mksh',
  'tcsh',
  'csh',
  'nu',
  'elvish',
  'xonsh',
  'pwsh',
  'powershell',
];

const plainShells = new Set(PLAIN_SHELL_COMMANDS);

export const PANE_MOUSE_FLAGS_FORMAT =
  '#{mouse_standard_flag} #{mouse_button_flag} #{mouse_all_flag} #{mouse_sgr_flag} #{pane_current_command}';

export const PANE_MOUSE_QUERY_TIMEOUT_MS = 5_000;

export function unknownMouseState(): PaneMouseState {
  return {
    tracking: 'none',
    sgr: false,
    utf8: false,
    urxvt: false,
    known: false,
    verifiedAt: null,
  };
}

export function isPlainShellCommand(command: string | null | undefined): boolean {
  if (!command) return false;
  const name = command.trim().split('/').pop() ?? '';
  return plainShells.has(name.startsWith('-') ? name.slice(1) : name);
}

export function parsePaneMouseFlags(stdout: string): PaneMouseFlags | null {
  const parts = stdout.trim().split(/\s+/);
  if (parts.length < 4 || parts.slice(0, 4).some((part) => part !== '0' && part !== '1')) {
    return null;
  }
  return {
    standard: parts[0] === '1',
    button: parts[1] === '1',
    all: parts[2] === '1',
    sgr: parts[3] === '1',
    currentCommand: parts.length > 4 ? parts.slice(4).join(' ') : null,
  };
}

export function trackingFromFlags(flags: PaneMouseFlags): MouseTracking {
  if (isPlainShellCommand(flags.currentCommand)) return 'none';
  if (flags.all) return 'any';
  if (flags.button) return 'button';
  return flags.standard ? 'normal' : 'none';
}

export function applyMouseFlags(state: PaneMouseState, flags: PaneMouseFlags, now: number): void {
  state.tracking = trackingFromFlags(flags);
  state.sgr = flags.sgr;
  state.known = true;
  state.verifiedAt = now;
}

/**
 * pane 是否在要这条鼠标上报。状态未知时按键/滚轮照常放行，移动事件丢弃
 * （holdUnknownMotion 为 false 时没有校准手段，沿用全部放行）。
 */
export function mouseReportAllowed(
  state: PaneMouseState,
  kind: MouseReportKind,
  holdUnknownMotion: boolean
): boolean {
  if (!state.known) return !(holdUnknownMotion && (kind === 'hover' || kind === 'drag'));
  if (state.tracking === 'none') return false;
  if (kind === 'hover') return state.tracking === 'any';
  if (kind === 'drag') return state.tracking === 'any' || state.tracking === 'button';
  return true;
}

/** 走控制通道读 pane 的鼠标标志；超时只拒绝本条，不毒化队列 */
export function queryPaneMouseFlags(
  queue: ControlModeCommandQueue,
  write: ((data: string) => void) | null,
  paneId: string,
  timeoutMs = PANE_MOUSE_QUERY_TIMEOUT_MS
): Promise<PaneMouseFlags | null> {
  if (!write || !isTmuxPaneId(paneId)) return Promise.resolve(null);
  return queue
    .execute(write, `display-message -p -t ${paneId} "${PANE_MOUSE_FLAGS_FORMAT}"`, {
      timeoutMs,
      poisonOnTimeout: false,
      transform: (block) => parsePaneMouseFlags(block.lines.join('\n')),
    })
    .catch(() => null);
}
