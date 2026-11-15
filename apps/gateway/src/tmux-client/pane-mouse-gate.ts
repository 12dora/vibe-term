import type { MouseReportingScanner } from './mouse-reporting-scanner';
import type { MouseSequence } from './mouse-sequence';
import {
  type PaneMouseFlags,
  applyMouseFlags,
  isPlainShellCommand,
  mouseReportAllowed,
} from './pane-mouse-state';

export type PaneMouseQuery = (paneId: string) => Promise<PaneMouseFlags | null>;

export interface PaneMouseLane {
  reporting: MouseReportingScanner;
  mouseQueryInFlight: boolean;
  lastMouseQueryAt: number;
  mouseDropped: number;
  lastMouseDropLogAt: number;
}

export interface PaneMouseGateHost {
  now(): number;
  debug(message: string): void;
  isLive(paneId: string, lane: PaneMouseLane): boolean;
  /** 校准或命令切换后确认 pane 不再要鼠标：清掉已排队的鼠标输入 */
  onDisabled(paneId: string, lane: PaneMouseLane): void;
}

/** 同一 pane 两次标志查询的最小间隔，也是已校准状态的有效期 */
export const MOUSE_QUERY_INTERVAL_MS = 2_000;
const DROP_LOG_INTERVAL_MS = 60_000;

export function mouseLaneFields(): Omit<PaneMouseLane, 'reporting'> {
  return {
    mouseQueryInFlight: false,
    lastMouseQueryAt: Number.NEGATIVE_INFINITY,
    mouseDropped: 0,
    lastMouseDropLogAt: Number.NEGATIVE_INFINITY,
  };
}

export class PaneMouseGate {
  private query: PaneMouseQuery | null = null;
  private droppedTotal = 0;

  constructor(private readonly host: PaneMouseGateHost) {}

  get mouseReportsDropped(): number {
    return this.droppedTotal;
  }

  setQuery(query: PaneMouseQuery | null): void {
    this.query = query;
  }

  admit(paneId: string, lane: PaneMouseLane, sequence: MouseSequence): boolean {
    const state = lane.reporting.state;
    const verifiedAt = state.known ? state.verifiedAt : null;
    if (verifiedAt === null || this.host.now() - verifiedAt >= MOUSE_QUERY_INTERVAL_MS) {
      this.refresh(paneId, lane);
    }
    if (mouseReportAllowed(state, sequence.kind, this.query !== null)) return true;
    this.noteDrop(paneId, lane, sequence);
    return false;
  }

  refresh(paneId: string, lane: PaneMouseLane): void {
    const query = this.query;
    const now = this.host.now();
    if (!query || lane.mouseQueryInFlight) return;
    if (now - lane.lastMouseQueryAt < MOUSE_QUERY_INTERVAL_MS) return;
    lane.mouseQueryInFlight = true;
    lane.lastMouseQueryAt = now;
    const settle = (flags: PaneMouseFlags | null) => {
      lane.mouseQueryInFlight = false;
      if (!flags || !this.host.isLive(paneId, lane)) return;
      applyMouseFlags(lane.reporting.state, flags, this.host.now());
      if (lane.reporting.state.tracking === 'none') this.host.onDisabled(paneId, lane);
    };
    void query(paneId).then(settle, () => settle(null));
  }

  /** 前台命令切换：回到 shell 立即视为关闭，换成其他程序则尽快重新校准 */
  noteCommand(paneId: string, lane: PaneMouseLane, command: string): void {
    const state = lane.reporting.state;
    if (isPlainShellCommand(command)) {
      state.tracking = 'none';
      state.known = true;
      this.host.onDisabled(paneId, lane);
      return;
    }
    state.verifiedAt = null;
    this.refresh(paneId, lane);
  }

  private noteDrop(paneId: string, lane: PaneMouseLane, sequence: MouseSequence): void {
    this.droppedTotal += 1;
    lane.mouseDropped += 1;
    const now = this.host.now();
    if (now - lane.lastMouseDropLogAt < DROP_LOG_INTERVAL_MS) return;
    lane.lastMouseDropLogAt = now;
    const state = lane.reporting.state;
    this.host.debug(
      `[tmux][input-lane] pane=${paneId} mouse_reports_dropped=${lane.mouseDropped} kind=${sequence.kind} tracking=${state.known ? state.tracking : 'unknown'}`
    );
  }
}
