// 设备页头部徽标的数据源：浏览器↔node 的承载与 RTT，以及 entry↔node 的到达路径。
//
// 数据来自 `DirectCarrierController.diagnosticsSource`——`node-runtimes.ts` 在给非 self 的
// node 建连时把它挂到 `connection.directDiagnostics`。connection 上没有（`self`、或直连
// 不可用）时 `resolveDirectDiagnostics()` 回落到恒为 `primary` 的桩，契约与桩都在
// `packages/ws-client/src/direct/types.ts`。

import { SELF_NODE_ID } from '@tmex/api-client';
import { DIRECT_FAILURE_CODES } from '@tmex/api-client/auth/index';
import type {
  DirectFailureCode,
  DirectFailureDcParams,
  DirectFailureWsParams,
  MeshNodeDirectFailure,
  MeshNodeReach,
  MeshNodeTransport,
} from '@tmex/api-client/auth/index';
import type { DirectDiagnostics } from '@tmex/ws-client/direct/types';
import { resolveDirectDiagnostics } from '@tmex/ws-client/direct/types';
import { useMemo, useSyncExternalStore } from 'react';
import { getMeshNodesState, subscribeMeshNodes } from './mesh-nodes';
import { appNodeRuntimes } from './node-runtimes';

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
}

const UNREACHABLE_LINK: NodeLink = {
  reach: null,
  transport: null,
  rttMs: null,
  peerAddress: null,
  linkSinceAt: null,
  directFailure: null,
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
