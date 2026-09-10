// 目标解析：node（id 或名字）、device（id 或名字），以及目标文法
// `[<node>/]<device>[:<window>[.<pane>]]`。
//
// 文法解析是纯函数（可单测）；window / pane 的实际定位要等会话树，由 term 命令组自己做。

import type { MeshNode } from '@vibeterm/api-client/auth/types';
import type { DeviceWithRuntime } from '@vibeterm/api-client/devices';
import { SELF_NODE_ID, isValidNodeId, normalizeNodeId } from '@vibeterm/api-client/node-url';
import { NotFoundError, UsageError } from './errors';
import type { HttpClient } from './http';

export interface TargetPart {
  /** 原文；可能是序号也可能是名字。 */
  raw: string;
  /** 全数字时的序号，否则 null。 */
  index: number | null;
}

export interface ParsedTarget {
  /** `<node>/` 部分；未写为 null（由 `--node` 或默认 entry 决定）。 */
  node: string | null;
  device: string;
  /** `:` 之后的原文。window/pane 拆分失败时可整段当窗口名回退。 */
  location: string | null;
  window: TargetPart | null;
  pane: TargetPart | null;
}

function part(raw: string): TargetPart {
  return { raw, index: /^\d+$/.test(raw) ? Number(raw) : null };
}

/**
 * 拆 `[<node>/]<device>[:<window>[.<pane>]]`。
 *
 * - node 与 device 以**第一个** `/` 分界；
 * - device 与 location 以**第一个** `:` 分界（名字里带 `:` 的设备请用 id 定位）；
 * - window 与 pane 以**最后一个** `.` 分界，同时保留 `location` 原文，供窗口名本身含 `.`
 *   时按整段回退。
 */
export function parseTarget(input: string): ParsedTarget {
  const raw = input.trim();
  if (!raw) throw new UsageError('target is empty');

  const slash = raw.indexOf('/');
  const node = slash >= 0 ? raw.slice(0, slash) : null;
  const rest = slash >= 0 ? raw.slice(slash + 1) : raw;
  if (node !== null && !node) throw new UsageError(`target has an empty node: "${input}"`);

  const colon = rest.indexOf(':');
  const device = colon >= 0 ? rest.slice(0, colon) : rest;
  const location = colon >= 0 ? rest.slice(colon + 1) : null;
  if (!device) throw new UsageError(`target has an empty device: "${input}"`);
  if (location !== null && !location) {
    throw new UsageError(`target has an empty window: "${input}"`);
  }

  if (location === null) {
    return { node, device, location: null, window: null, pane: null };
  }
  const dot = location.lastIndexOf('.');
  if (dot < 0) {
    return { node, device, location, window: part(location), pane: null };
  }
  const windowRaw = location.slice(0, dot);
  const paneRaw = location.slice(dot + 1);
  if (!windowRaw || !paneRaw) throw new UsageError(`target has an empty pane: "${input}"`);
  return { node, device, location, window: part(windowRaw), pane: part(paneRaw) };
}

export function formatTarget(target: ParsedTarget): string {
  const head = target.node ? `${target.node}/${target.device}` : target.device;
  return target.location ? `${head}:${target.location}` : head;
}

export interface ResolvedNode {
  id: string;
  name: string;
  /** entry 自身（`self`）。 */
  isSelf: boolean;
  row: MeshNode | null;
}

const SELF_ALIASES: ReadonlySet<string> = new Set(['self', 'local', 'entry', '.']);

export class Resolver {
  private nodesCache: MeshNode[] | null = null;
  private readonly devicesCache = new Map<string, DeviceWithRuntime[]>();

  constructor(private readonly http: HttpClient) {}

  /** `GET /api/mesh/nodes`；standalone 入口没有这个路由（404），返回空表。 */
  async listNodes(): Promise<MeshNode[]> {
    if (this.nodesCache) return this.nodesCache;
    const response = await this.http.fetch(SELF_NODE_ID, '/api/mesh/nodes');
    if (response.status === 404) {
      this.nodesCache = [];
      return this.nodesCache;
    }
    await this.http.assertOk(SELF_NODE_ID, response, '/api/mesh/nodes');
    const payload = (await response.json()) as { nodes?: MeshNode[] };
    this.nodesCache = payload.nodes ?? [];
    return this.nodesCache;
  }

  /** node id、node 名字或 `self` 都接受；不给（undefined / 空）即 entry 自身。 */
  async resolveNode(ref: string | null | undefined): Promise<ResolvedNode> {
    const raw = ref?.trim() ?? '';
    if (!raw || SELF_ALIASES.has(raw.toLowerCase())) {
      return { id: SELF_NODE_ID, name: 'self', isSelf: true, row: null };
    }
    // 已经是规范 node id 的话不需要名册：名册取不到（未登录 / standalone）也照样能拼路径。
    if (isValidNodeId(raw)) {
      const id = normalizeNodeId(raw);
      const roster = await this.listNodes().catch(() => [] as MeshNode[]);
      const row = roster.find((node) => node.id === id) ?? null;
      return { id, name: row?.name ?? id, isSelf: false, row };
    }
    const nodes = await this.listNodes();
    const matches = nodes.filter((node) => node.name === raw);
    if (matches.length === 1) return nodeResult(matches[0]);
    if (matches.length > 1) {
      throw new UsageError(
        `node name "${raw}" is ambiguous: ${matches.map((node) => node.id).join(', ')}`,
        'use the node id instead'
      );
    }
    const insensitive = nodes.filter((node) => node.name.toLowerCase() === raw.toLowerCase());
    if (insensitive.length === 1) return nodeResult(insensitive[0]);
    throw new NotFoundError(`unknown node: ${raw}`, 'run: vibeterm nodes ls');
  }

  async listDevices(nodeId: string): Promise<DeviceWithRuntime[]> {
    const cached = this.devicesCache.get(nodeId);
    if (cached) return cached;
    const payload = await this.http.json<{ devices?: DeviceWithRuntime[] }>(
      nodeId,
      'GET',
      '/api/devices'
    );
    const devices = payload.devices ?? [];
    this.devicesCache.set(nodeId, devices);
    return devices;
  }

  /** device id 或名字（先精确匹配，再忽略大小写）。 */
  async resolveDevice(nodeId: string, ref: string): Promise<DeviceWithRuntime> {
    const raw = ref.trim();
    if (!raw) throw new UsageError('device is empty');
    const devices = await this.listDevices(nodeId);
    const byId = devices.find((device) => device.id === raw);
    if (byId) return byId;
    const exact = devices.filter((device) => device.name === raw);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      throw new UsageError(
        `device name "${raw}" is ambiguous on node ${nodeId}`,
        'use the device id instead'
      );
    }
    const insensitive = devices.filter((device) => device.name.toLowerCase() === raw.toLowerCase());
    if (insensitive.length === 1) return insensitive[0];
    throw new NotFoundError(
      `unknown device: ${raw}`,
      `run: vibeterm devices ls${nodeId === SELF_NODE_ID ? '' : ` --node ${nodeId}`}`
    );
  }
}

function nodeResult(row: MeshNode): ResolvedNode {
  return { id: row.id, name: row.name, isSelf: false, row };
}
