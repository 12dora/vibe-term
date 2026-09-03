// 「光标对齐」(follow) 键盘模式的逐帧轮询何时可以停。
//
// 光标移动不发任何事件，所以避让量只能靠 RAF 逐帧测量迭代收敛（见 use-keyboard-avoidance
// 的说明）。但收敛之后继续每帧测量就是纯浪费：每帧两次 getBoundingClientRect + 一次
// getComputedStyle 都会强制同步布局，手机上键盘弹起期间一直烧 60 Hz。
//
// 判据：测量签名连续 FOLLOW_STABLE_FRAMES 帧不变、且距最后一次变化已过 FOLLOW_SETTLE_MS
// （留足「按键 → 设备回显 → 光标移动」的往返时间，含 mesh 远端）才算收敛。收敛后调用方退到
// 低频探测，输入/焦点/viewport/转屏事件与探测到的光标位移都经 invalidate() 立刻回到逐帧。
export const FOLLOW_STABLE_FRAMES = 3;
export const FOLLOW_SETTLE_MS = 600;

export type FollowLoopPace = 'frame' | 'idle';

export class FollowLoopGate {
  private signature: string | null = null;
  private stableFrames = 0;
  private lastChangeAt = Number.NEGATIVE_INFINITY;

  observe(signature: string, now: number): FollowLoopPace {
    if (signature !== this.signature) {
      this.signature = signature;
      this.stableFrames = 0;
      this.lastChangeAt = now;
      return 'frame';
    }
    this.stableFrames += 1;
    if (this.stableFrames < FOLLOW_STABLE_FRAMES || now - this.lastChangeAt < FOLLOW_SETTLE_MS) {
      return 'frame';
    }
    return 'idle';
  }

  invalidate(now: number): void {
    this.stableFrames = 0;
    this.lastChangeAt = now;
  }

  reset(): void {
    this.signature = null;
    this.stableFrames = 0;
    this.lastChangeAt = Number.NEGATIVE_INFINITY;
  }
}

// 收敛后的低频探测周期：终端输出会移动光标却不发任何事件，只能靠它发现。探测只读光标
// 位置与键盘高度，位置没变就把周期翻倍到上限继续睡。
export const FOLLOW_IDLE_PROBE_MS = 250;
export const FOLLOW_IDLE_PROBE_MAX_MS = 1000;

export interface FollowLoopHost {
  now(): number;
  requestFrame(fn: () => void): number;
  cancelFrame(handle: number): void;
  requestIdle(fn: () => void, ms: number): unknown;
  cancelIdle(handle: unknown): void;
  /** 一次完整测量并应用（即 hook 里的 compute()）；末尾须回调 pace()。 */
  measure(): void;
  /** 低频探测：只读光标底沿与键盘高度，返回可比较的签名。 */
  probe(): string;
}

// follow 循环的节奏控制：未收敛时逐帧（RAF），收敛后退到低频探测（timer）并指数放缓，
// 探测发现光标动了或外部事件到来就立刻回到逐帧。
export class FollowLoopScheduler {
  private readonly gate = new FollowLoopGate();
  private frame: number | null = null;
  private idle: unknown = null;
  private idleMs = FOLLOW_IDLE_PROBE_MS;
  private lastProbe = '';

  constructor(private readonly host: FollowLoopHost) {}

  /** 每次测量末尾调用：签名交给收敛判据，决定下一拍是逐帧还是低频探测。 */
  pace(signature: string, probe: string): void {
    this.lastProbe = probe;
    if (this.gate.observe(signature, this.host.now()) === 'frame') {
      this.runFrame();
    } else {
      this.park();
    }
  }

  /** 外部事件（输入 / 焦点 / viewport / 转屏 / 快捷键栏尺寸变化）让收敛判定失效。 */
  invalidate(): void {
    this.gate.invalidate(this.host.now());
  }

  stop(): void {
    this.cancelFrame();
    this.cancelIdle();
    this.gate.reset();
    this.lastProbe = '';
    this.idleMs = FOLLOW_IDLE_PROBE_MS;
  }

  /** 当前节奏，供测试与诊断读取。 */
  get state(): 'frame' | 'idle' | 'stopped' {
    if (this.frame !== null) {
      return 'frame';
    }
    return this.idle !== null ? 'idle' : 'stopped';
  }

  private runFrame(): void {
    this.cancelIdle();
    this.idleMs = FOLLOW_IDLE_PROBE_MS;
    if (this.frame === null) {
      this.frame = this.host.requestFrame(() => {
        this.frame = null;
        this.host.measure();
      });
    }
  }

  private park(): void {
    this.cancelFrame();
    if (this.idle === null) {
      this.idle = this.host.requestIdle(() => {
        this.idle = null;
        this.tickIdle();
      }, this.idleMs);
    }
  }

  private tickIdle(): void {
    if (this.host.probe() === this.lastProbe) {
      this.idleMs = Math.min(this.idleMs * 2, FOLLOW_IDLE_PROBE_MAX_MS);
      this.park();
      return;
    }
    this.gate.invalidate(this.host.now());
    this.host.measure();
  }

  private cancelFrame(): void {
    if (this.frame !== null) {
      this.host.cancelFrame(this.frame);
      this.frame = null;
    }
  }

  private cancelIdle(): void {
    if (this.idle !== null) {
      this.host.cancelIdle(this.idle);
      this.idle = null;
    }
  }
}
