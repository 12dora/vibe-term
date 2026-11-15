/** 超时拆掉的队头：tmux 仍可能晚到 `%end`，带截止时间；过期后只按 seq 丢弃，避免 FIFO 吞掉后续用户命令。 */
export interface OrphanControlBlock {
  literal: boolean;
  deadline: number;
  headSince: number;
  poisonOnStall: boolean;
  seq?: number;
}

/** 过期 orphan 的 command-number 暂留，用来识别迟到块，避免把它 stamp 到下一条命令上。 */
const MAX_DISCARDED_ORPHAN_SEQS = 16;

export class ControlOrphanBook {
  private readonly orphans: OrphanControlBlock[] = [];
  private readonly discardedSeqs: number[] = [];

  get size(): number {
    return this.orphans.length;
  }

  get head(): OrphanControlBlock | undefined {
    return this.orphans[0];
  }

  hasStallCandidate(): boolean {
    return this.orphans.some((orphan) => orphan.poisonOnStall);
  }

  earliestDeadline(): number {
    let at = Number.POSITIVE_INFINITY;
    for (const orphan of this.orphans) at = Math.min(at, orphan.deadline);
    return at;
  }

  add(orphan: OrphanControlBlock): void {
    this.orphans.push(orphan);
  }

  clear(): void {
    this.orphans.length = 0;
    this.discardedSeqs.length = 0;
  }

  /** 返回是否丢掉了计入卡死判定的 orphan（tmux 仍欠它一个回执）。 */
  prune(now: number): boolean {
    let droppedStallCandidate = false;
    while (this.orphans.length > 0) {
      const head = this.orphans[0];
      if (!head || head.deadline > now) break;
      this.orphans.shift();
      if (head.poisonOnStall) droppedStallCandidate = true;
      if (head.seq !== undefined) this.rememberDiscardedSeq(head.seq);
    }
    return droppedStallCandidate;
  }

  /** `%begin` 归属 orphan 时返回其 literal 标记；undefined 表示交给 pending。 */
  literalForBegin(seq: number | undefined): boolean | undefined {
    if (seq !== undefined && this.discardedSeqs.includes(seq)) return false;
    const orphan = this.orphanForBegin(seq);
    if (!orphan) return undefined;
    stampSeq(orphan, seq);
    return orphan.literal;
  }

  takeDiscardedSeq(seq: number): boolean {
    const index = this.discardedSeqs.indexOf(seq);
    if (index < 0) return false;
    this.discardedSeqs.splice(index, 1);
    return true;
  }

  consume(seq: number | undefined): boolean {
    if (this.orphans.length === 0) return false;
    const matched = seq === undefined ? -1 : this.orphans.findIndex((orphan) => orphan.seq === seq);
    if (matched >= 0) {
      this.orphans.splice(matched, 1);
      return true;
    }
    const head = this.orphans[0];
    if (seq !== undefined && head?.seq !== undefined) return false;
    this.orphans.shift();
    return true;
  }

  /** 与 consume 对齐：已知 seq 且对不上的 orphan 跳过，把 %begin 交给 pending。 */
  private orphanForBegin(seq: number | undefined): OrphanControlBlock | undefined {
    if (seq !== undefined) {
      const matched = this.orphans.find((orphan) => orphan.seq === seq);
      if (matched) return matched;
    }
    const head = this.orphans[0];
    if (!head) return undefined;
    if (seq !== undefined && head.seq !== undefined) return undefined;
    return head;
  }

  private rememberDiscardedSeq(seq: number): void {
    if (this.discardedSeqs.includes(seq)) return;
    this.discardedSeqs.push(seq);
    if (this.discardedSeqs.length > MAX_DISCARDED_ORPHAN_SEQS) this.discardedSeqs.shift();
  }
}

export function parseNonNegativeInteger(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** `%begin/%end` 参数为 `time command-number flags`；缺字段时无法对号。 */
export function parseCommandNumber(args: string): number | undefined {
  const firstSpace = args.indexOf(' ');
  if (firstSpace < 0) return undefined;
  const rest = args.slice(firstSpace + 1);
  const secondSpace = rest.indexOf(' ');
  const field = secondSpace < 0 ? rest : rest.slice(0, secondSpace);
  const parsed = parseNonNegativeInteger(field);
  return parsed === null ? undefined : parsed;
}

export function stampSeq(target: { seq?: number }, seq: number | undefined): void {
  if (target.seq === undefined && seq !== undefined) target.seq = seq;
}
