// 浏览器侧传输的进度模型（纯逻辑，无 UI / IO）。
//
// 一次传输（批）由若干条目组成，每个条目有两段（leg）：
//   上传：leg1 浏览器 → VibeTerm（网络），leg2 VibeTerm → 设备（落盘 / commit）；
//   下载：leg1 设备 → VibeTerm（准备），leg2 VibeTerm → 浏览器（网络）。
// 两段按 `weights` 合成一条进度；批的总进度按条目大小加权，速率只看网络那一段。

import type { LegProgress } from '@vibeterm/api-client';
import type { TransferPath } from './bulk-transfer';

export type TransferDirection = 'upload' | 'download';

export type ItemStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export type TransferStage =
  | 'queued'
  | 'preparing'
  | 'transferring'
  | 'writing'
  | 'done'
  | 'failed'
  | 'cancelled';

/** 条目成功之前的进度上限：收尾（commit / 保存）完成前不报满。 */
export const UNFINISHED_PROGRESS_CAP = 0.99;

/** 列表里最多展示的条目数；再多只会拖慢渲染，总进度已经由总览条给出。 */
export const MAX_VISIBLE_ROWS = 30;

export type LegWeights = readonly [number, number];

const DEFAULT_WEIGHTS: LegWeights = [1, 1];

interface LegState {
  /** 是否收到过这一段的回报（区分「还没开始」与「0%」）。 */
  seen: boolean;
  bytes?: number;
  total?: number;
  pct: number;
}

const EMPTY_LEG: LegState = { seen: false, pct: 0 };

interface ItemProgress {
  name: string;
  size: number;
  status: ItemStatus;
  legs: readonly [LegState, LegState];
  weights: LegWeights;
}

export interface ItemSpec {
  name: string;
  size: number;
}

export interface ItemView {
  /** 条目在批里的下标，列表渲染用作 key（不同目录可以有同名文件）。 */
  index: number;
  name: string;
  stage: TransferStage;
  /** 0-100，整数，未成功前最多 99。 */
  pct: number;
}

export interface BatchView {
  direction: TransferDirection;
  /** 0-1。 */
  fraction: number;
  /** 0-100，整数，全部成功前最多 99。 */
  pct: number;
  /** 按进度折算的已完成字节（与进度条一致）。 */
  transferredBytes: number;
  totalBytes: number;
  /** 网络那一段已传的字节，速率估计的输入。 */
  networkBytes: number;
  itemsDone: number;
  itemsFailed: number;
  itemsTotal: number;
  path: TransferPath | null;
  /** 尚未成功的条目（至多 `MAX_VISIBLE_ROWS` 个，按原顺序）。 */
  rows: readonly ItemView[];
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

function finiteOrUndefined(n: number | undefined): number | undefined {
  return n !== undefined && Number.isFinite(n) && n >= 0 ? n : undefined;
}

function toLegState(p: LegProgress): LegState {
  return {
    seen: true,
    bytes: finiteOrUndefined(p.bytes),
    total: finiteOrUndefined(p.totalBytes),
    pct: Number.isFinite(p.pct) ? Math.max(0, Math.min(100, p.pct)) : 0,
  };
}

/** 一段的完成比例：有精确字节就用字节，否则退回百分比。 */
function legFraction(leg: LegState, size: number): number {
  const total = leg.total ?? (leg.bytes !== undefined ? size : undefined);
  if (leg.bytes !== undefined && total !== undefined && total > 0) {
    return clamp01(leg.bytes / total);
  }
  return clamp01(leg.pct / 100);
}

function legBytes(leg: LegState, size: number): number {
  return leg.bytes ?? legFraction(leg, size) * size;
}

function sanitizeWeights(w: LegWeights): LegWeights {
  const fix = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  return [fix(w[0]), fix(w[1])];
}

/** 条目比例 = 两段按权重的加权平均；成功之前封顶，成功后恒为 1。 */
function itemFraction(item: ItemProgress): number {
  if (item.status === 'done') return 1;
  if (item.status === 'queued') return 0;
  const [w1, w2] = item.weights;
  const sum = w1 + w2;
  if (sum <= 0) return 0;
  const f1 = legFraction(item.legs[0], item.size);
  const f2 = legFraction(item.legs[1], item.size);
  return Math.min((w1 * f1 + w2 * f2) / sum, UNFINISHED_PROGRESS_CAP);
}

function networkLegIndex(direction: TransferDirection): 0 | 1 {
  return direction === 'upload' ? 0 : 1;
}

function itemNetworkBytes(item: ItemProgress, direction: TransferDirection): number {
  if (item.status === 'done') return item.size;
  return legBytes(item.legs[networkLegIndex(direction)], item.size);
}

function runningStage(item: ItemProgress, direction: TransferDirection): TransferStage {
  const [l1] = item.legs;
  if (direction === 'upload') {
    if (!l1.seen) return 'preparing';
    return legFraction(l1, item.size) < 1 ? 'transferring' : 'writing';
  }
  // 下载：权重里 leg1 为 0 表示准备阶段已结束（见 `onLegWeights`）
  const prepared = item.weights[0] === 0 || legFraction(l1, item.size) >= 1;
  return prepared ? 'transferring' : 'preparing';
}

function itemStage(item: ItemProgress, direction: TransferDirection): TransferStage {
  return item.status === 'running' ? runningStage(item, direction) : item.status;
}

function toItemView(item: ItemProgress, index: number, direction: TransferDirection): ItemView {
  return {
    index,
    name: item.name,
    stage: itemStage(item, direction),
    pct: Math.floor(itemFraction(item) * 100),
  };
}

function newItem({ name, size }: ItemSpec): ItemProgress {
  return {
    name,
    size: Math.max(0, size),
    status: 'queued',
    legs: [EMPTY_LEG, EMPTY_LEG],
    weights: DEFAULT_WEIGHTS,
  };
}

/** 一次批量传输的可变进度状态；`view()` 给出可直接渲染的快照。 */
export class BatchProgress {
  private readonly items: ItemProgress[];
  private path: TransferPath | null = null;

  constructor(
    readonly direction: TransferDirection,
    specs: readonly ItemSpec[]
  ) {
    this.items = specs.map(newItem);
  }

  get size(): number {
    return this.items.length;
  }

  leg(index: number, leg: 1 | 2, p: LegProgress): void {
    const item = this.items[index];
    if (!item) return;
    const legs: [LegState, LegState] = [item.legs[0], item.legs[1]];
    legs[leg - 1] = toLegState(p);
    this.items[index] = { ...item, legs };
  }

  weights(index: number, w: LegWeights): void {
    const item = this.items[index];
    if (item) this.items[index] = { ...item, weights: sanitizeWeights(w) };
  }

  setStatus(index: number, status: ItemStatus): void {
    const item = this.items[index];
    if (item) this.items[index] = { ...item, status };
  }

  /** 任何一个条目落到中继就算中继（直连失败会整次回落）。 */
  setPath(path: TransferPath): void {
    if (this.path === null || path === 'relay') this.path = path;
  }

  view(): BatchView {
    const { direction, items } = this;
    let totalBytes = 0;
    let weighted = 0;
    let fractionSum = 0;
    let networkBytes = 0;
    let itemsDone = 0;
    let itemsFailed = 0;
    const rows: ItemView[] = [];
    items.forEach((item, index) => {
      const fraction = itemFraction(item);
      totalBytes += item.size;
      weighted += item.size * fraction;
      fractionSum += fraction;
      networkBytes += itemNetworkBytes(item, direction);
      if (item.status === 'done') itemsDone += 1;
      else if (rows.length < MAX_VISIBLE_ROWS) rows.push(toItemView(item, index, direction));
      if (item.status === 'failed') itemsFailed += 1;
    });
    // 全是 0 字节文件（或大小未知）时没有字节可加权，退回条目平均
    const fraction =
      totalBytes > 0 ? weighted / totalBytes : items.length > 0 ? fractionSum / items.length : 0;
    return {
      direction,
      fraction,
      pct: Math.floor(fraction * 100),
      transferredBytes: Math.round(totalBytes > 0 ? weighted : 0),
      totalBytes,
      networkBytes,
      itemsDone,
      itemsFailed,
      itemsTotal: items.length,
      path: this.path,
      rows,
    };
  }
}
