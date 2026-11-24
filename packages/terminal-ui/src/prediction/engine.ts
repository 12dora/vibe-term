import type { PredictionFrame, PredictionOverlay, PredictionOverlayCell } from 'ghostty-terminal';
import {
  BACKSPACE_RE,
  type Position,
  type Prediction,
  type RunCell,
  type Verdict,
  cellMatches,
  collectPrior,
  cursorPosition,
  inViewport,
  isBlank,
  isPredictionSuppressed,
  isSubstantive,
  judgeOnCursorRow,
  overlaps,
  printableGraphemes,
  samePosition,
  skipPending,
  span,
} from './cells';

export { PREDICTION_MAX_GRAPHEMES, isPredictionSuppressed, printableGraphemes } from './cells';

export const PREDICTION_MIN_EXPIRY_MS = 1500;
export const PREDICTION_MISMATCH_WINDOW_MS = 30_000;
export const PREDICTION_MISMATCH_LIMIT = 3;
export const PREDICTION_SUSPEND_MS = 60_000;
/** 光标类误判的宽限：须在后续帧仍成立且距首次出现已过宽限，才算误判 */
export const PREDICTION_SUSPECT_GRACE_MS = 120;

export interface PredictionEngineOptions {
  textWidth: (text: string) => 1 | 2;
  now?: () => number;
}

export interface PredictionEngine {
  /** 用户输入已发出；frame 为发出时刻的画面状态 */
  onInput(data: string, frame: PredictionFrame | null): void;
  /** 不可预测的输入（粘贴）：结束当前 epoch */
  breakRun(): void;
  /** 每个渲染帧对账 */
  onFrame(frame: PredictionFrame): void;
  /** 无新帧时按时钟检查过期与待定误判 */
  tick(): void;
  setRttMs(rttMs: number | null): void;
  /** 快照替换 / 重连 / 关闭：丢弃全部预测，不计入误判 */
  reset(): void;
  overlay(): PredictionOverlay | null;
  /** 下一次需要 tick 的时刻；无未决预测时为 null */
  nextDeadline(): number | null;
  /** overlay 每次变化递增 */
  readonly version: number;
  readonly suspended: boolean;
  /** 窗口内已计入的可见误判次数 */
  readonly recentMismatches: number;
}

type Occupancy = 'free' | 'occupied' | 'blocked';

class Engine implements PredictionEngine {
  version = 0;
  private predictions: Prediction[] = [];
  private readonly confirmedEpochs = new Set<number>();
  private epoch = 0;
  private run: RunCell[] = [];
  private runStartCol = 0;
  private next: Position | null = null;
  private generation: number | null = null;
  private lastFrame: PredictionFrame | null = null;
  private rttMs: number | null = null;
  private mismatchTimes: number[] = [];
  private suspendedUntil = 0;
  private suspectSince: number | null = null;
  private suspectSeenAgain = false;
  private cachedOverlay: PredictionOverlay | null = null;
  private cachedVersion = -1;

  constructor(
    private readonly textWidth: (text: string) => 1 | 2,
    private readonly now: () => number
  ) {}

  get suspended(): boolean {
    return this.now() < this.suspendedUntil;
  }

  get recentMismatches(): number {
    const at = this.now();
    return this.mismatchTimes.filter((time) => at - time < PREDICTION_MISMATCH_WINDOW_MS).length;
  }

  onInput(data: string, frame: PredictionFrame | null): void {
    const at = this.now();
    if (!frame) {
      this.endEpoch();
      return;
    }
    this.observe(frame);
    if (isPredictionSuppressed(frame)) {
      this.clearAll();
      return;
    }
    if (at < this.suspendedUntil || !this.predictInput(data, frame, at)) this.endEpoch();
  }

  breakRun(): void {
    this.endEpoch();
  }

  onFrame(frame: PredictionFrame): void {
    this.observe(frame);
    if (isPredictionSuppressed(frame)) {
      this.clearAll();
      return;
    }
    this.validateAll(frame, this.now());
  }

  tick(): void {
    const at = this.now();
    if (this.predictions.some((p) => this.expired(p, at) && this.isDisplayed(p))) {
      this.mismatch(at);
      return;
    }
    this.dropExpiredTentative(at);
    const deadline = this.suspectDeadline();
    if (deadline !== null && at >= deadline) this.settleSuspect(at);
  }

  /**
   * 宽限点到了：有后续帧佐证的照常判误判；只有一帧的，之后再无输出说明重绘已落定，
   * 仍可疑就静默丢弃（不计数，防止把卡住的半截重绘算成误判）。
   */
  private settleSuspect(at: number): void {
    const frame = this.lastFrame;
    if (!frame) return;
    if (this.suspectSeenAgain) {
      this.validateAll(frame, at);
      return;
    }
    const verdicts = this.predictions.map((p) => this.validate(p, frame, at));
    if (verdicts.includes('suspect') || verdicts.includes('mismatch')) {
      this.clearAll();
      return;
    }
    this.clearSuspect();
    this.applyVerdicts(verdicts);
  }

  setRttMs(value: number | null): void {
    this.rttMs = value !== null && Number.isFinite(value) && value >= 0 ? value : null;
  }

  reset(): void {
    this.clearAll();
    this.generation = null;
  }

  overlay(): PredictionOverlay | null {
    if (this.cachedVersion !== this.version) {
      this.cachedVersion = this.version;
      this.cachedOverlay = this.buildOverlay();
    }
    return this.cachedOverlay;
  }

  nextDeadline(): number | null {
    if (this.predictions.length === 0) return null;
    const expiry = Math.min(...this.predictions.map((p) => p.bornAt)) + this.expiryMs();
    const suspect = this.suspectDeadline();
    return suspect === null ? expiry : Math.min(expiry, suspect);
  }

  private suspectDeadline(): number | null {
    return this.suspectSince === null ? null : this.suspectSince + PREDICTION_SUSPECT_GRACE_MS;
  }

  private expiryMs(): number {
    return Math.max(PREDICTION_MIN_EXPIRY_MS, this.rttMs === null ? 0 : 4 * this.rttMs);
  }

  private expired(prediction: Prediction, at: number): boolean {
    return at - prediction.bornAt > this.expiryMs();
  }

  /** 暂定预测从未画出，过期只静默丢弃，不连累已可见的 epoch */
  private dropExpiredTentative(at: number): void {
    const before = this.predictions.length;
    this.predictions = this.predictions.filter((p) => this.isDisplayed(p) || !this.expired(p, at));
    if (this.predictions.length !== before) this.pruneEpochs();
  }

  private isDisplayed(prediction: Prediction): boolean {
    return this.confirmedEpochs.has(prediction.epoch);
  }

  private hasVisible(): boolean {
    return this.predictions.some((p) => this.isDisplayed(p));
  }

  private touch(): void {
    this.version += 1;
  }

  private observe(frame: PredictionFrame): void {
    if (this.generation !== null && this.generation !== frame.generation) this.clearAll();
    this.generation = frame.generation;
    if (this.lastFrame?.viewportTop !== frame.viewportTop && this.hasVisible()) this.touch();
    this.lastFrame = frame;
  }

  private endEpoch(): void {
    const cursorShown =
      this.next !== null &&
      this.confirmedEpochs.has(this.epoch) &&
      this.predictions.some((p) => p.epoch === this.epoch);
    if (cursorShown) this.touch();
    this.epoch += 1;
    this.run = [];
    this.next = null;
  }

  private clearAll(): void {
    if (this.hasVisible()) this.touch();
    this.predictions = [];
    this.confirmedEpochs.clear();
    this.clearSuspect();
    this.endEpoch();
  }

  private clearSuspect(): void {
    this.suspectSince = null;
    this.suspectSeenAgain = false;
  }

  private mismatch(at: number): void {
    const visible = this.hasVisible();
    this.clearAll();
    if (!visible) return;
    this.mismatchTimes = this.mismatchTimes.filter(
      (time) => at - time < PREDICTION_MISMATCH_WINDOW_MS
    );
    this.mismatchTimes.push(at);
    if (this.mismatchTimes.length >= PREDICTION_MISMATCH_LIMIT) {
      this.suspendedUntil = at + PREDICTION_SUSPEND_MS;
      this.mismatchTimes = [];
    }
  }

  private predictInput(data: string, frame: PredictionFrame, at: number): boolean {
    this.dropStaleAnchor(frame);
    if (BACKSPACE_RE.test(data)) {
      return Array.from(data).every(() => this.predictBackspace(frame, at));
    }
    const graphemes = printableGraphemes(data);
    return graphemes?.every((g) => this.predictChar(g, frame, at)) ?? false;
  }

  /** 连续输入已全部落定、真实光标却不在接续位置（被别处挪走）：放弃旧锚点，重新暂定 */
  private dropStaleAnchor(frame: PredictionFrame): void {
    const next = this.next;
    if (!next) return;
    const cursor = cursorPosition(frame);
    if (samePosition(next, cursor)) return;
    if (this.predictions.some((p) => p.epoch === this.epoch)) return;
    if (this.run.some((cell) => skipPending(cell, cursor))) return;
    this.endEpoch();
  }

  private targetFor(width: number, frame: PredictionFrame): Position | null {
    const position = this.next ?? cursorPosition(frame);
    if (position.col + width > frame.cols || !inViewport(frame, position.row)) return null;
    return position;
  }

  private occupancy(
    position: Position,
    width: number,
    frame: PredictionFrame,
    covered: readonly Prediction[]
  ): Occupancy {
    if (covered.some((p) => p.epoch !== this.epoch)) return 'blocked';
    const viewportRow = position.row - frame.viewportTop;
    for (let col = position.col; col < position.col + width; col += 1) {
      const coveredHere = covered.some((p) => overlaps(p, position.row, col, 1));
      if (!coveredHere && !isBlank(frame.cellAt(viewportRow, col))) return 'occupied';
    }
    return 'free';
  }

  private predictChar(text: string, frame: PredictionFrame, at: number): boolean {
    const width = this.textWidth(text);
    const position = this.targetFor(width, frame);
    if (!position) return false;
    const covered = this.predictions.filter((p) => overlaps(p, position.row, position.col, width));
    const occupancy = this.occupancy(position, width, frame, covered);
    if (occupancy === 'blocked') return false;
    // 已可见的 epoch 允许覆盖自动建议等残留内容（确认仍要求光标越过且内容相等）；暂定 epoch 只占位
    if (occupancy === 'occupied' && !this.confirmedEpochs.has(this.epoch)) {
      this.advance({ ...position, text, wide: width === 2, skipped: true });
      return true;
    }
    if (covered.length > 0) this.predictions = this.predictions.filter((p) => !covered.includes(p));
    const prediction = this.addPrediction(position, text, width === 2, at, collectPrior(covered));
    this.advance({ ...position, text, wide: prediction.wide });
    if (this.isDisplayed(prediction) || covered.some((p) => this.isDisplayed(p))) this.touch();
    return true;
  }

  private advance(cell: RunCell): void {
    if (this.run.length === 0) this.runStartCol = cell.col;
    this.run.push(cell);
    this.next = { row: cell.row, col: cell.col + span(cell) };
  }

  private addPrediction(
    position: Position,
    text: string,
    wide: boolean,
    at: number,
    prior: string[]
  ): Prediction {
    const prediction: Prediction = {
      row: position.row,
      col: position.col,
      text,
      wide,
      erase: text === '',
      epoch: this.epoch,
      bornAt: at,
      minCol: this.runStartCol,
      prior,
    };
    this.predictions.push(prediction);
    return prediction;
  }

  private predictBackspace(frame: PredictionFrame, at: number): boolean {
    const last = this.run.at(-1);
    const next = this.next;
    if (!last || !next || next.row !== last.row || next.col !== last.col + span(last)) return false;
    if (!inViewport(frame, last.row)) return false;
    this.run.pop();
    this.next = { row: last.row, col: last.col };
    if (last.skipped) return true;
    const outstanding = this.predictions.find(
      (p) => p.epoch === this.epoch && !p.erase && p.row === last.row && p.col === last.col
    );
    const erase = outstanding ?? this.addPrediction(last, '', last.wide, at, [last.text]);
    if (outstanding) {
      outstanding.prior.push(outstanding.text);
      Object.assign(outstanding, { text: '', erase: true, bornAt: at });
    }
    if (this.isDisplayed(erase)) this.touch();
    return true;
  }

  private validate(prediction: Prediction, frame: PredictionFrame, at: number): Verdict {
    if (this.expired(prediction, at)) return this.isDisplayed(prediction) ? 'mismatch' : 'gone';
    if (!inViewport(frame, prediction.row)) return 'gone';
    const matches = cellMatches(prediction, frame);
    if (frame.viewportTop + frame.cursor.row === prediction.row) {
      return judgeOnCursorRow(prediction, frame, matches);
    }
    if (!matches) return 'suspect';
    // 光标不在预测行时的相等只对已可见的 epoch 有效（输入后回车、滚动），不能把暂定 epoch 转为可见
    return this.isDisplayed(prediction) ? 'confirmed' : 'pending';
  }

  private validateAll(frame: PredictionFrame, at: number): void {
    if (this.predictions.length === 0) {
      this.clearSuspect();
      return;
    }
    const verdicts = this.predictions.map((p) => this.validate(p, frame, at));
    if (verdicts.includes('mismatch')) {
      this.mismatch(at);
      return;
    }
    if (!verdicts.includes('suspect')) {
      this.clearSuspect();
    } else if (this.suspectSince === null) {
      this.suspectSince = at;
    } else {
      this.suspectSeenAgain = true;
      if (at - this.suspectSince >= PREDICTION_SUSPECT_GRACE_MS) {
        this.mismatch(at);
        return;
      }
    }
    this.applyVerdicts(verdicts);
  }

  /** 本轮有非空白确认、且同 epoch 没有可疑判定的 epoch 才转为可见 */
  private promotableEpochs(verdicts: readonly Verdict[]): Set<number> {
    const doubtful = new Set(
      this.predictions.filter((_, i) => verdicts[i] === 'suspect').map((p) => p.epoch)
    );
    const epochs = this.predictions
      .filter((p, i) => verdicts[i] === 'confirmed' && isSubstantive(p) && !doubtful.has(p.epoch))
      .map((p) => p.epoch);
    return new Set(epochs);
  }

  private applyVerdicts(verdicts: readonly Verdict[]): void {
    const settled = this.predictions.filter(
      (_, i) => verdicts[i] === 'confirmed' || verdicts[i] === 'gone'
    );
    if (settled.length === 0) return;
    const promoted = this.promotableEpochs(verdicts);
    const hadVisibleSettled = settled.some((p) => this.isDisplayed(p));
    this.predictions = this.predictions.filter(
      (_, i) => verdicts[i] === 'pending' || verdicts[i] === 'suspect'
    );
    const revealed = [...promoted].some(
      (e) => !this.confirmedEpochs.has(e) && this.predictions.some((p) => p.epoch === e)
    );
    for (const e of promoted) this.confirmedEpochs.add(e);
    if (hadVisibleSettled || revealed) this.touch();
    this.pruneEpochs();
  }

  private pruneEpochs(): void {
    for (const e of [...this.confirmedEpochs]) {
      if (e !== this.epoch && !this.predictions.some((p) => p.epoch === e)) {
        this.confirmedEpochs.delete(e);
      }
    }
  }

  private buildOverlay(): PredictionOverlay | null {
    const frame = this.lastFrame;
    if (!frame) return null;
    const cells: PredictionOverlayCell[] = this.predictions
      .filter((p) => this.isDisplayed(p) && inViewport(frame, p.row))
      .map((p) => ({
        row: p.row - frame.viewportTop,
        col: p.col,
        text: p.text,
        wide: p.wide,
        underline: !p.erase,
      }));
    if (cells.length === 0) return null;
    return { cells, cursor: this.overlayCursor(frame) };
  }

  private overlayCursor(frame: PredictionFrame): Position | null {
    const next = this.next;
    if (!next || !this.confirmedEpochs.has(this.epoch) || !inViewport(frame, next.row)) {
      return null;
    }
    if (!this.predictions.some((p) => p.epoch === this.epoch)) return null;
    return { row: next.row - frame.viewportTop, col: next.col };
  }
}

export function createPredictionEngine(options: PredictionEngineOptions): PredictionEngine {
  return new Engine(options.textWidth, options.now ?? Date.now);
}
