// 设备页头部徽标的数据源：浏览器↔node 的承载与 RTT、entry↔node 的到达路径，
// 以及组成「源主机 → 终端」这条链路的两段延迟。
//
// 数据来自 `DirectCarrierController.diagnosticsSource`——`node-runtimes.ts` 在给非 self 的
// node 建连时把它挂到 `connection.directDiagnostics`。connection 上没有（`self`、或直连
// 不可用）时 `resolveDirectDiagnostics()` 回落到恒为 `primary` 的桩，契约与桩都在
// `packages/ws-client/src/direct/types.ts`。

import { SELF_NODE_ID } from '@vibeterm/api-client';
import { DIRECT_FAILURE_CODES } from '@vibeterm/api-client/auth/index';
import type {
  DirectFailureCode,
  DirectFailureDcParams,
  DirectFailureWsParams,
  MeshNodeDirectFailure,
  MeshNodeReach,
  MeshNodeTransport,
} from '@vibeterm/api-client/auth/index';
import type { DeviceLatencySample, TmuxState } from '@vibeterm/stores/tmux-state';
import type { DirectDiagnostics } from '@vibeterm/ws-client/direct/types';
import { resolveDirectDiagnostics } from '@vibeterm/ws-client/direct/types';
import { useMemo, useSyncExternalStore } from 'react';
import { getMeshNodesState, subscribeMeshNodes } from './mesh-nodes';
import { appNodeRuntimes } from './node-runtimes';
import { relayPresenceOf, viaRelayOf } from './relay-extras';

/** 浏览器 ↔ 该 node 的承载诊断。 */
export function useDirectDiagnostics(nodeId: string): DirectDiagnostics {
  const source = useMemo(
    () => resolveDirectDiagnostics(appNodeRuntimes.get(nodeId).connection),
    [nodeId]
  );
  return useSyncExternalStore(source.subscribe, source.get, source.get);
}

/** entry ↔ 该 node 的链路：到达路径、承载、往返时延与这条链路的现场信息。 */
export interface NodeLink {
  reach: MeshNodeReach;
  transport: MeshNodeTransport;
  /** entry ↔ node 的往返毫秒数；未测得为 `null`。 */
  rttMs: number | null;
  /** 对端地址：`ws-secure` / `dc` 为对端主机，`relay` 为 hub 主机；未知为 `null`。 */
  peerAddress: string | null;
  /** 当前链路建立时刻（epoch 毫秒）；未知为 `null`。 */
  linkSinceAt: number | null;
  /** 最近一次直连尝试的失败原因；已直连或从未尝试为 `null`。 */
  directFailure: MeshNodeDirectFailure | null;
  /** `transport === 'relay'` 时这条链路走的那台中继；其余情况（含旧网关）为 `null`。 */
  viaRelay: string | null;
  /** 该对端当前在线的全部中继；旧网关或 hub 模式为空数组。 */
  relayPresence: string[];
}

const UNREACHABLE_LINK: NodeLink = {
  reach: null,
  transport: null,
  rttMs: null,
  peerAddress: null,
  linkSinceAt: null,
  directFailure: null,
  viaRelay: null,
  relayPresence: [],
};

export function useNodeLink(nodeId: string): NodeLink {
  const state = useSyncExternalStore(subscribeMeshNodes, getMeshNodesState, getMeshNodesState);
  const node = state.nodes.find(
    (row) => row.id === nodeId || (state.entryNodeId === row.id && nodeId === SELF_NODE_ID)
  );
  if (!node) return UNREACHABLE_LINK;
  return {
    reach: normalizeReach(node.reach),
    transport: normalizeTransport(node.transport),
    rttMs: typeof node.rttMs === 'number' && Number.isFinite(node.rttMs) ? node.rttMs : null,
    peerAddress: normalizeText(node.peerAddress),
    linkSinceAt:
      typeof node.linkSinceAt === 'number' && Number.isFinite(node.linkSinceAt)
        ? node.linkSinceAt
        : null,
    directFailure: normalizeDirectFailure(node.directFailure),
    viaRelay: viaRelayOf(node.viaRelay),
    relayPresence: relayPresenceOf(node.relayPresence),
  };
}

function normalizeText(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const KNOWN_FAILURE_CODES = new Set<string>(DIRECT_FAILURE_CODES);

/** 认不出的码（更新的网关新增的）当作没有码，回落原文，不至于把 key 摆到界面上。 */
function normalizeFailureCode(code: unknown): DirectFailureCode | null {
  return typeof code === 'string' && KNOWN_FAILURE_CODES.has(code)
    ? (code as DirectFailureCode)
    : null;
}

function normalizeWsParams(params: unknown): DirectFailureWsParams | null {
  if (!params || typeof params !== 'object') return null;
  const { url, seconds } = params as DirectFailureWsParams;
  const out: DirectFailureWsParams = {};
  if (typeof url === 'string' && url.length > 0) out.url = url;
  if (typeof seconds === 'number' && Number.isFinite(seconds)) out.seconds = seconds;
  return out;
}

function normalizeDcParams(params: unknown): DirectFailureDcParams | null {
  if (!params || typeof params !== 'object') return null;
  const { until } = params as DirectFailureDcParams;
  return typeof until === 'number' && Number.isFinite(until) ? { until } : {};
}

function normalizeDirectFailure(
  failure: MeshNodeDirectFailure | null | undefined
): MeshNodeDirectFailure | null {
  if (!failure || typeof failure !== 'object') return null;
  const ws = normalizeText(failure.ws);
  const dc = normalizeText(failure.dc);
  if (!ws && !dc) return null;
  return {
    at: typeof failure.at === 'number' ? failure.at : 0,
    ws,
    wsCode: ws ? normalizeFailureCode(failure.wsCode) : null,
    wsParams: ws ? normalizeWsParams(failure.wsParams) : null,
    dc,
    dcCode: dc ? normalizeFailureCode(failure.dcCode) : null,
    dcParams: dc ? normalizeDcParams(failure.dcParams) : null,
  };
}

function normalizeReach(reach: string | null | undefined): MeshNodeReach {
  return reach === 'lan' || reach === 'wan' || reach === 'relay' ? reach : null;
}

function normalizeTransport(transport: string | null | undefined): MeshNodeTransport {
  return transport === 'ws-secure' || transport === 'relay' || transport === 'dc'
    ? transport
    : null;
}

/**
 * 「源主机 → 终端」这条链路的两段延迟。
 *
 * - 浏览器 ↔ node：该 node 自己那条 Gateway WS 的心跳往返（直连活着时心跳走 DataChannel），
 *   已经含了 entry 转发、peer link 与中继在内的每一跳。
 * - node ↔ tmux：拥有该设备的网关按 DEVICE_LATENCY 帧下发；旧节点不播报能力，这一段测不到。
 */
export interface NodeLatency {
  browserToNodeMs: number | null;
  browserToNodeRawMs: number | null;
  hostHop: DeviceLatencySample | null;
  /** 该 node 的网关是否播报 `device-latency-v1`。 */
  hostHopSupported: boolean;
}

interface TmuxStateReader {
  subscribe: (listener: () => void) => () => void;
  getState: () => TmuxState;
}

/**
 * 按 nodeId 读该 node 运行时的 tmux store，不依赖 `RuntimeProvider`：徽标与
 * `useDirectDiagnostics` 一样以 nodeId 为准，页面区之外（以及服务端渲染）也能取到同一份值。
 * 选择器只取标量或 store 内稳定的对象引用，`useSyncExternalStore` 才不会每帧判定为变更。
 */
function useTmuxSlice<T>(store: TmuxStateReader, select: (state: TmuxState) => T): T {
  const read = () => select(store.getState());
  return useSyncExternalStore(store.subscribe, read, read);
}

/**
 * 宿主一跳按**字段**读，不整对象读：网关每 15 s 重发一帧，读数一模一样，store 里换的却是一个
 * 新对象——整对象读会让 `useSyncExternalStore` 每次都判定为变更，徽标跟着空转。
 */
export function selectDeviceLatencyField<K extends keyof DeviceLatencySample>(
  state: TmuxState,
  deviceId: string | undefined,
  field: K
): DeviceLatencySample[K] | null {
  if (!deviceId) return null;
  return state.deviceLatency[deviceId]?.[field] ?? null;
}

/** 逐字段装配回样本；任一字段缺席即视作「这台设备还没有宿主一跳读数」。 */
export function composeHostHop(fields: {
  rttMs: number | null;
  rawMs: number | null;
  hop: DeviceLatencySample['hop'] | null;
  sampledAt: number | null;
  receivedAt: number | null;
}): DeviceLatencySample | null {
  const { rttMs, rawMs, hop, sampledAt, receivedAt } = fields;
  if (rttMs === null || rawMs === null || hop === null) return null;
  if (sampledAt === null || receivedAt === null) return null;
  return { rttMs, rawMs, hop, sampledAt, receivedAt };
}

export function useNodeLatency(nodeId: string, deviceId?: string): NodeLatency {
  const store = useMemo<TmuxStateReader>(
    () => appNodeRuntimes.get(nodeId).runtime.stores.tmux,
    [nodeId]
  );
  const browserToNodeMs = useTmuxSlice(store, (state) => state.wsLatencyMs);
  const browserToNodeRawMs = useTmuxSlice(store, (state) => state.wsLatencyRawMs ?? null);
  const hostHopSupported = useTmuxSlice(store, (state) => state.deviceLatencySupported === true);
  const rttMs = useTmuxSlice(store, (state) => selectDeviceLatencyField(state, deviceId, 'rttMs'));
  const rawMs = useTmuxSlice(store, (state) => selectDeviceLatencyField(state, deviceId, 'rawMs'));
  const hop = useTmuxSlice(store, (state) => selectDeviceLatencyField(state, deviceId, 'hop'));
  const sampledAt = useTmuxSlice(store, (state) =>
    selectDeviceLatencyField(state, deviceId, 'sampledAt')
  );
  const receivedAt = useTmuxSlice(store, (state) =>
    selectDeviceLatencyField(state, deviceId, 'receivedAt')
  );
  const hostHop = useMemo(
    () => composeHostHop({ rttMs, rawMs, hop, sampledAt, receivedAt }),
    [rttMs, rawMs, hop, sampledAt, receivedAt]
  );
  return useMemo(
    () => ({ browserToNodeMs, browserToNodeRawMs, hostHop, hostHopSupported }),
    [browserToNodeMs, browserToNodeRawMs, hostHop, hostHopSupported]
  );
}
