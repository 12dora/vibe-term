import type { StagePackageResult } from './upgrade-staging';

/** 暂存 PUT 的入场闸门：追加同 key 可顶掉挂死的流，乱序同 key 允许多条并行。 */
export class StagingWriteGate {
  writes = 0;
  version: string | null = null;
  key: string | null = null;
  mode: 'append' | 'ranged' | null = null;
  preempt: (() => void) | null = null;
  done: Promise<void> = Promise.resolve();
  private releaseDone: (() => void) | null = null;
  private admit: Promise<void> = Promise.resolve();

  get inFlight(): boolean {
    return this.writes > 0;
  }

  reset(): void {
    this.writes = 0;
    this.version = null;
    this.key = null;
    this.mode = null;
    this.preempt = null;
    this.done = Promise.resolve();
    this.releaseDone = null;
    this.admit = Promise.resolve();
  }

  async admitWrite(
    key: string,
    version: string,
    ranged: boolean,
    isBusy: () => boolean
  ): Promise<StagePackageResult | null> {
    const decision = await this.withAdmit(() => this.decide(key, version, ranged, isBusy));
    if (decision.kind === 'reject') return decision.result;
    if (decision.kind === 'wait') {
      await this.done;
      return this.admitWrite(key, version, ranged, isBusy);
    }
    return null;
  }

  releaseWrite(): void {
    this.writes = Math.max(0, this.writes - 1);
    if (this.writes > 0) return;
    this.version = null;
    this.key = null;
    this.mode = null;
    this.preempt = null;
    const release = this.releaseDone;
    this.releaseDone = null;
    release?.();
  }

  private withAdmit<T>(fn: () => T): Promise<T> {
    let unlock!: () => void;
    const prev = this.admit;
    this.admit = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    return prev.then(fn, fn).finally(() => unlock());
  }

  private decide(
    key: string,
    version: string,
    ranged: boolean,
    isBusy: () => boolean
  ): { kind: 'accept' } | { kind: 'wait' } | { kind: 'reject'; result: StagePackageResult } {
    if (isBusy()) {
      return { kind: 'reject', result: { ok: false, status: 409, code: 'UPGRADE_IN_PROGRESS' } };
    }
    if (this.writes > 0) {
      if (this.key !== key) {
        return { kind: 'reject', result: { ok: false, status: 409, code: 'UPGRADE_IN_PROGRESS' } };
      }
      if (!(ranged && this.mode === 'ranged')) {
        this.preempt?.();
        return { kind: 'wait' };
      }
    }
    this.writes += 1;
    this.version = version;
    this.key = key;
    this.mode = ranged ? 'ranged' : 'append';
    if (this.writes === 1) {
      this.done = new Promise<void>((resolve) => {
        this.releaseDone = resolve;
      });
    }
    return { kind: 'accept' };
  }
}
