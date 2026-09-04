// 指标面板的取数层：从一份 `RelayMetricsResponse` 里派生序列、中位数与成员排序。
// 全是纯函数，组件只负责摆版式。

import type {
  RelayMetricsMember,
  RelayMetricsResponse,
  RelayMetricsSample,
} from '@tmex/api-client/relay/metrics-types';
import { median } from './relay-format';

/** 趋势区一次画一条线所需的取值与端点标注。 */
export interface MetricSeries {
  values: number[];
  min: number;
  max: number;
  last: number;
}

export function metricSeries(
  samples: readonly RelayMetricsSample[],
  pick: (sample: RelayMetricsSample) => number | null
): MetricSeries {
  const values = samples.map((sample) => {
    const value = pick(sample);
    return value !== null && Number.isFinite(value) ? value : 0;
  });
  if (values.length === 0) return { values: [], min: 0, max: 0, last: 0 };
  return {
    values,
    min: Math.min(...values),
    max: Math.max(...values),
    last: values[values.length - 1],
  };
}

export interface RelayTrendSeries {
  bytesIn: MetricSeries;
  bytesOut: MetricSeries;
  activeStreams: MetricSeries;
  eventLoopLagMs: MetricSeries;
  membersOnline: MetricSeries;
  /** 采样覆盖的时间跨度（毫秒）；样本不足两个时为 0。 */
  windowMs: number;
}

export function relayTrendSeries(data: RelayMetricsResponse): RelayTrendSeries {
  const samples = data.history.samples;
  const interval = data.history.intervalMs > 0 ? data.history.intervalMs : data.intervalMs;
  return {
    bytesIn: metricSeries(samples, (s) => s.bytesInPerSec),
    bytesOut: metricSeries(samples, (s) => s.bytesOutPerSec),
    activeStreams: metricSeries(samples, (s) => s.activeStreams),
    eventLoopLagMs: metricSeries(samples, (s) => s.eventLoopLagMs),
    membersOnline: metricSeries(samples, (s) => s.membersOnline),
    windowMs: samples.length > 1 ? (samples.length - 1) * interval : 0,
  };
}

/** 在线成员的 RTT 中位数；离线成员的 RTT 是上次的残值，不参与统计。 */
export function medianMemberRttMs(members: readonly RelayMetricsMember[]): number | null {
  return median(members.filter((member) => member.online).map((member) => member.rttMs));
}

/** 在线成员里的最大 RTT，作为中位数磁贴的副行。 */
export function maxMemberRttMs(members: readonly RelayMetricsMember[]): number | null {
  const online = members
    .filter((member) => member.online && member.rttMs !== null)
    .map((member) => member.rttMs as number);
  return online.length === 0 ? null : Math.max(...online);
}

/** 全部成员的重连次数之和；离线成员也算进去，断线本身就是要看的量。 */
export function totalMemberReconnects(members: readonly RelayMetricsMember[]): number {
  return members.reduce(
    (sum, member) => sum + (Number.isFinite(member.reconnects) ? member.reconnects : 0),
    0
  );
}

/** 成员标题：有名字用名字，否则用节点号前 8 位。 */
export function memberTitle(member: RelayMetricsMember): string {
  const name = member.name?.trim();
  if (name) return name;
  return member.nodeId.length <= 8 ? member.nodeId : member.nodeId.slice(0, 8);
}

/** 事件循环延迟的告警档：超过 100ms 就该看一眼，超过 250ms 是明确的过载。 */
export type MetricLevel = 'ok' | 'warn' | 'bad';

export function eventLoopLevel(lagMs: number): MetricLevel {
  if (!Number.isFinite(lagMs) || lagMs < 100) return 'ok';
  return lagMs < 250 ? 'warn' : 'bad';
}

/** 成员 RTT 的告警档。`null`（还没测出来）按正常算，不制造无谓的黄块。 */
export function rttLevel(rttMs: number | null): MetricLevel {
  if (rttMs === null || !Number.isFinite(rttMs) || rttMs < 150) return 'ok';
  return rttMs < 400 ? 'warn' : 'bad';
}

export function cpuLevel(pct: number | null): MetricLevel {
  if (pct === null || !Number.isFinite(pct) || pct < 70) return 'ok';
  return pct < 90 ? 'warn' : 'bad';
}

const LEVEL_TONE = { ok: 'default', warn: 'warning', bad: 'destructive' } as const;

export function levelTone(level: MetricLevel): 'default' | 'warning' | 'destructive' {
  return LEVEL_TONE[level];
}

// ---------------------------------------------------------------------------
// 接入节点表的检索 / 排序
// ---------------------------------------------------------------------------

export type MemberSortKey =
  | 'node'
  | 'state'
  | 'rtt'
  | 'streams'
  | 'rate'
  | 'reconnects'
  | 'connected';

export type SortDirection = 'asc' | 'desc';

export interface MemberSort {
  key: MemberSortKey;
  direction: SortDirection;
}

export const DEFAULT_MEMBER_SORT: MemberSort = { key: 'node', direction: 'asc' };

export type MemberStateFilter = 'all' | 'online' | 'offline';

export interface MemberFilter {
  /** 匹配节点名 / 节点号 / 租户号，大小写不敏感。 */
  query: string;
  state: MemberStateFilter;
  /** 选中的租户；`null` 即不按租户过滤。 */
  tenantId: string | null;
}

export const EMPTY_MEMBER_FILTER: MemberFilter = { query: '', state: 'all', tenantId: null };

function matchesQuery(member: RelayMetricsMember, query: string): boolean {
  return (
    memberTitle(member).toLowerCase().includes(query) ||
    member.nodeId.toLowerCase().includes(query) ||
    member.tenantId.toLowerCase().includes(query)
  );
}

function matchesState(member: RelayMetricsMember, state: MemberStateFilter): boolean {
  if (state === 'online') return member.online;
  if (state === 'offline') return !member.online;
  return true;
}

export function filterMembers(
  members: readonly RelayMetricsMember[],
  filter: MemberFilter
): RelayMetricsMember[] {
  const query = filter.query.trim().toLowerCase();
  return members.filter((member) => {
    if (filter.tenantId !== null && member.tenantId !== filter.tenantId) return false;
    if (!matchesState(member, filter.state)) return false;
    return query === '' || matchesQuery(member, query);
  });
}

/** 每个排序列取一个可比较的值；`null` 表示「没有这个量」，恒排在最后。 */
const MEMBER_SORT_VALUE: Record<
  MemberSortKey,
  (member: RelayMetricsMember) => string | number | null
> = {
  node: (member) => memberTitle(member).toLowerCase(),
  state: (member) => (member.online ? 0 : 1),
  rtt: (member) => (member.online ? member.rttMs : null),
  streams: (member) => member.activeStreams,
  rate: (member) => member.bytesInPerSec + member.bytesOutPerSec,
  reconnects: (member) => member.reconnects,
  connected: (member) => member.connectedAt,
};

function compareValues(a: string | number, b: string | number): number {
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
  return Number(a) - Number(b);
}

export function sortMembersBy(
  members: readonly RelayMetricsMember[],
  sort: MemberSort
): RelayMetricsMember[] {
  const pick = MEMBER_SORT_VALUE[sort.key];
  const factor = sort.direction === 'desc' ? -1 : 1;
  return [...members].sort((a, b) => {
    const left = pick(a);
    const right = pick(b);
    // 缺值不跟着方向翻面：升降序都摆在最后，免得一点降序整屏都是「—」。
    if (left === null || right === null) {
      if (left === right) return a.nodeId.localeCompare(b.nodeId);
      return left === null ? 1 : -1;
    }
    const primary = compareValues(left, right);
    if (primary !== 0) return primary * factor;
    return a.nodeId.localeCompare(b.nodeId);
  });
}

/** 点表头：换列即回到升序，同列再点一次翻面。 */
export function toggleMemberSort(current: MemberSort, key: MemberSortKey): MemberSort {
  if (current.key !== key) return { key, direction: 'asc' };
  return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
}
