import { logAt } from '../log/level';

/** 控制通道健康跃迁：slow = 命令超时但通道仍在出数据；stalled = 整窗无进展、即将拆通道；recovered = 恢复正常。 */
export type ControlHealthEvent = {
  kind: 'slow' | 'recovered' | 'stalled';
  deviceId: string;
  headAgeMs: number;
  lastActivityAgoMs: number;
};

export type ControlHealthKind = ControlHealthEvent['kind'];

export interface ControlHealthInfo {
  headAgeMs: number;
  lastActivityAgoMs: number;
}

/** 控制队列的健康出口：只在跃迁时上报，degraded 让队列在正常回执时才去报恢复。 */
export interface ControlHealthSink {
  readonly degraded: boolean;
  report(kind: ControlHealthKind, info: ControlHealthInfo): void;
}

type HealthState = 'healthy' | 'slow' | 'stalled';

/** 每设备一份，跨控制通道重连保留状态：同一次事故只记一次 slow，恢复时带上持续时长。 */
export class ControlHealthReporter implements ControlHealthSink {
  private state: HealthState = 'healthy';
  private degradedSince = 0;

  constructor(
    private readonly deviceId: string,
    private readonly emit: (event: ControlHealthEvent) => void,
    private readonly now: () => number = () => Date.now()
  ) {}

  get degraded(): boolean {
    return this.state !== 'healthy';
  }

  report(kind: ControlHealthKind, info: ControlHealthInfo): void {
    if (kind === 'recovered') {
      if (this.state === 'healthy') return;
      logAt(
        'warn',
        `[tmux] control channel recovered device=${this.deviceId} slow_ms=${this.now() - this.degradedSince}`
      );
      this.state = 'healthy';
    } else {
      if (this.state === kind || (kind === 'slow' && this.state === 'stalled')) return;
      if (this.state === 'healthy') this.degradedSince = this.now();
      this.state = kind;
      logAt(
        'warn',
        `[tmux] control channel ${kind} device=${this.deviceId} head_age_ms=${info.headAgeMs} last_activity_ms=${info.lastActivityAgoMs}`
      );
    }
    this.dispatch(kind, info);
  }

  private dispatch(kind: ControlHealthKind, info: ControlHealthInfo): void {
    try {
      this.emit({ kind, deviceId: this.deviceId, ...info });
    } catch (error) {
      console.error('[tmux-client] control health listener failed:', error);
    }
  }
}
