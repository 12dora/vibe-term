export const BELL_DEDUP_WINDOW_MS = 200;
export const CONTROL_MAX_RESTARTS = 3;
export const CONTROL_RESTART_DELAY_MS = 500;
export const CONTROL_STABLE_RESET_MS = 10_000;
export const CONTROL_STDERR_TAIL_LIMIT = 2048;
export const CONTROL_ATTACH_READY_TIMEOUT_MS = 3000;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_TIMEOUT_MS = 10_000;
export const PARKING_WINDOW_NAME = 'vibeterm-park';
/** tmex 时期的护盾窗口名：1.x 崩在 attach 中途会留下它，快照仍需过滤并在 attach 时改名。 */
export const LEGACY_PARKING_WINDOW_NAME = 'tmex-park';

export function isParkingWindowName(name: string): boolean {
  return name === PARKING_WINDOW_NAME || name === LEGACY_PARKING_WINDOW_NAME;
}
export const THEME_2031_OPTION = '@vibeterm_2031';
/** tmex 时期的 mode 2031 pane 选项，attach 时搬迁到新名。 */
export const LEGACY_THEME_2031_OPTION = '@tmex_2031';
