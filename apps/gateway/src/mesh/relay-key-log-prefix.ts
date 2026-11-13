import { bytesEqual } from '@vibeterm/shared/auth';
import type { RelayKeyLogEntry } from '@vibeterm/shared/relay';
import { stamp } from './mesh-log';
import type { KeyLogApplier } from './types';

export type RelayKeyLogPrefixPort = {
  generation(): number;
  applier: KeyLogApplier;
  readRemoteAt(seq: bigint): Promise<RelayKeyLogEntry | null>;
  url(): string;
};

/** secondary 的前缀校验：远端日志是不是本地日志的前缀；`diverged` 仅本连接有效。 */
export class RelayKeyLogPrefix {
  diverged = false;
  private divergedLogged = false;

  constructor(private readonly port: RelayKeyLogPrefixPort) {}

  reset(): void {
    this.diverged = false;
    this.divergedLogged = false;
  }

  /**
   * secondary 只向「远端是本地前缀」的中继补推：空日志可引导新中继；对不上则记分叉、不 push。
   * 返回 false 表示这一轮不能补推。
   */
  async verify(
    generation: number,
    userId: string,
    remote: bigint,
    localSeq: bigint
  ): Promise<boolean> {
    const prefix = await this.remoteIsLocalPrefix(generation, userId, remote, localSeq);
    if (prefix === 'prefix') return true;
    if (prefix === 'diverged') this.noteDiverged(remote, localSeq);
    return false;
  }

  /**
   * 记录是 prev_hash 哈希链：每条 bytes 含前驱 `hash = sha256(pred.bytes ‖ pred.sig)`，
   * sig 覆盖整条 bytes。比对远端 head 的 bytes+sig 即提交了整个 `1..head` 前缀——
   * 中间被截断、重排或分叉都会改变后续 prev_hash，head 必然对不上。
   * 另校验远端 head seq ≤ 本地，且解出的 seq 与声称的 head 一致（`readRemoteAt`）。
   */
  private async remoteIsLocalPrefix(
    generation: number,
    userId: string,
    remote: bigint,
    localSeq: bigint
  ): Promise<'prefix' | 'diverged' | 'unknown'> {
    if (remote > localSeq) return 'unknown';
    if (remote === 0n) return 'prefix';
    const remoteRec = await this.port.readRemoteAt(remote);
    if (!remoteRec || generation !== this.port.generation()) return 'unknown';
    const localRows = (await this.port.applier.list?.(userId, remote, undefined, 1)) ?? [];
    const localRec = localRows.find((row) => row.seq === remote);
    if (!localRec) return 'diverged';
    return bytesEqual(remoteRec.bytes, localRec.bytes) && bytesEqual(remoteRec.sig, localRec.sig)
      ? 'prefix'
      : 'diverged';
  }

  private noteDiverged(remote: bigint, local: bigint): void {
    this.diverged = true;
    if (this.divergedLogged) return;
    this.divergedLogged = true;
    console.warn(
      stamp(
        `[mesh][relay] key-log diverged url=${this.port.url()} remote_head=${String(remote)} local_head=${String(local)}`
      )
    );
  }
}
