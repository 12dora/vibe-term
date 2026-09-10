// 每 node 的 WS 4401 恢复策略：**一次 4401 是假设，不是判决**。
//
// 目标 node 的网关对任何一次流拆除都回 4401（链路抖动、入口侧流迁移、中转流重置），
// 而不只是「会话真的失效了」。就地把该 node 判成未登录，会把整棵子树退回「登录此节点」，
// 而连接又已经停掉——现网 2.0.7 的表现就是设备永远停在「连接中…」。
//
// 因此 4401 之后先用一次**带会话**的 HTTP 探测问一句「会话还在吗」，再决定怎么处置：
//   * 探测成功：会话有效，这次 4401 是瞬时故障 → 退避重连，登录态一动不动；
//     同一窗口内连续 N 次「探测成功但 WS 又 4401」才退回原来的「需要登录」结论，
//     真坏掉的 node 不会无限重连下去。
//   * 探测回 401 `NODE_LOGIN_REQUIRED`：静默重登一次，成功即重连；
//     重登失败（或宿主没接重登实现）才退回「需要登录」。
//   * 探测本身打不通（node 不可达）：与瞬时同类——不可达不是鉴权结论，退避重连。

import { createNodeApiClient, fetchDevices, isNodeLoginRequiredError } from '@vibeterm/api-client';

/** 探测结论：会话有效 / 该 node 要重新登录 / 根本没问到（不可达、网络错误）。 */
export type NodeSessionProbe = 'ok' | 'login-required' | 'unreachable';

/** 同一窗口内允许「探测成功但 WS 又 4401」的次数，超过即退回「需要登录」。 */
export const DEFAULT_MAX_TRANSIENT_4401 = 3;

/** 上面那个计数的滑动窗口。 */
export const DEFAULT_TRANSIENT_WINDOW_MS = 5 * 60_000;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** 缺省探测：拉一次该 node 的设备列表，最便宜的「带会话」端点。 */
export async function probeNodeSessionByDevices(nodeId: string): Promise<NodeSessionProbe> {
  try {
    await fetchDevices(createNodeApiClient(nodeId));
    return 'ok';
  } catch (error) {
    return isNodeLoginRequiredError(error) ? 'login-required' : 'unreachable';
  }
}

export interface NodeSessionGuardOptions {
  /** 会话探测（测试注入）；缺省拉一次该 node 的设备列表。 */
  probe?: (nodeId: string) => Promise<NodeSessionProbe>;
  /** 静默重登；宿主不接时探测回 `login-required` 即直接退回「需要登录」。 */
  relogin?: (nodeId: string) => Promise<boolean>;
  /** 判定为瞬时故障后的重连动作。 */
  reconnect: (nodeId: string) => void;
  /** 退回原有行为：该 node 显示「登录此节点」。 */
  onLoginRequired: (nodeId: string) => void;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  now?: () => number;
  maxTransient?: number;
  windowMs?: number;
}

interface GuardRecord {
  /** 窗口内「探测成功但 WS 又 4401」的时间点。 */
  transientAt: number[];
  /** 连续 4401 的次数，只用来算重连退避。 */
  streak: number;
  lastAt: number;
  running: boolean;
  timer: unknown;
}

function emptyRecord(): GuardRecord {
  return { transientAt: [], streak: 0, lastAt: 0, running: false, timer: null };
}

export class NodeSessionGuard {
  private readonly records = new Map<string, GuardRecord>();

  constructor(private readonly options: NodeSessionGuardOptions) {}

  private get maxTransient(): number {
    return this.options.maxTransient ?? DEFAULT_MAX_TRANSIENT_4401;
  }

  private get windowMs(): number {
    return this.options.windowMs ?? DEFAULT_TRANSIENT_WINDOW_MS;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** 收到一次非 self 的 4401：探测后再决定重连还是退回「需要登录」。 */
  handle(nodeId: string): Promise<void> {
    const record = this.record(nodeId);
    // 上一轮恢复还在跑：那一轮的结论会覆盖这一次，重复探测只是白发请求。
    if (record.running) return Promise.resolve();
    record.running = true;
    return this.recover(nodeId, record).finally(() => {
      record.running = false;
    });
  }

  /** 该 node 的运行时被回收：清掉计数与待发的重连。 */
  forget(nodeId: string): void {
    const record = this.records.get(nodeId);
    if (!record) return;
    this.clearTimer(record);
    this.records.delete(nodeId);
  }

  dispose(): void {
    for (const nodeId of [...this.records.keys()]) this.forget(nodeId);
  }

  private record(nodeId: string): GuardRecord {
    let record = this.records.get(nodeId);
    if (!record) {
      record = emptyRecord();
      this.records.set(nodeId, record);
    }
    const at = this.now();
    // 距上一次 4401 已经超过一个窗口：这是新的一轮，退避与计数都从头来。
    if (record.lastAt !== 0 && at - record.lastAt > this.windowMs) {
      record.transientAt = [];
      record.streak = 0;
    }
    record.lastAt = at;
    return record;
  }

  private async recover(nodeId: string, record: GuardRecord): Promise<void> {
    const probe = this.options.probe ?? probeNodeSessionByDevices;
    const result = await probe(nodeId).catch((): NodeSessionProbe => 'unreachable');
    if (result === 'login-required') {
      await this.afterLoginRequired(nodeId, record);
      return;
    }
    if (result === 'ok' && !this.noteTransient(record)) {
      // 会话查着是好的，WS 却一直被踢：这台 node 已经不是「抖了一下」，交回原有结论。
      this.reset(record);
      this.options.onLoginRequired(nodeId);
      return;
    }
    this.scheduleReconnect(nodeId, record);
  }

  private async afterLoginRequired(nodeId: string, record: GuardRecord): Promise<void> {
    const relogin = this.options.relogin;
    const ok = relogin ? await relogin(nodeId).catch(() => false) : false;
    if (!ok) {
      this.reset(record);
      this.options.onLoginRequired(nodeId);
      return;
    }
    // 重登成功：这一轮的瞬时计数作废，重连按第一次的退避走。
    record.transientAt = [];
    this.scheduleReconnect(nodeId, record);
  }

  /** 记一次「探测成功但 WS 4401」；仍在允许次数内返回 true。 */
  private noteTransient(record: GuardRecord): boolean {
    const at = this.now();
    record.transientAt = record.transientAt.filter((stamp) => at - stamp <= this.windowMs);
    record.transientAt.push(at);
    return record.transientAt.length <= this.maxTransient;
  }

  private scheduleReconnect(nodeId: string, record: GuardRecord): void {
    this.clearTimer(record);
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** record.streak, RECONNECT_MAX_MS);
    record.streak += 1;
    const schedule = this.options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    record.timer = schedule(() => {
      record.timer = null;
      this.options.reconnect(nodeId);
    }, delay);
  }

  private clearTimer(record: GuardRecord): void {
    if (record.timer === null) return;
    const cancel =
      this.options.cancel ??
      ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    cancel(record.timer);
    record.timer = null;
  }

  private reset(record: GuardRecord): void {
    this.clearTimer(record);
    record.transientAt = [];
    record.streak = 0;
  }
}
