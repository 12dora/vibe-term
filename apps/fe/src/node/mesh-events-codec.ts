// `/mesh/ws` 的帧编解码：NODE_EVENT / RTC_SIGNAL / ENROLL_REDEEMED 的线上表示与页面侧类型。
// 纯函数 + 类型，不碰连接状态（连接在 mesh-events.ts）。

import type { MeshNodeReach, MeshNodeTransport } from '@vibeterm/api-client/auth/index';
import { wsBorsh } from '@vibeterm/shared';
import { encodeBase64url } from '@vibeterm/shared/auth';
import { relayPresenceOf, viaRelayOf } from './relay-extras';

export type NodeEventStatus = 'online' | 'offline' | 'revoked';
export type NodeReach = MeshNodeReach;
export type NodeTransport = MeshNodeTransport;

export interface NodeEventPayload {
  nodeId: string;
  status: NodeEventStatus;
  reach: NodeReach;
  /** peer link 的实际承载；老 node 的帧里没有这一段，解出为 `undefined`。 */
  transport?: NodeTransport;
  /** entry ↔ node 最近一次 ping/pong 往返毫秒数；未测得为 `null`，帧里没有为 `undefined`。 */
  rttMs?: number | null;
  /**
   * `transport === 'relay'` 时这条链路走的那台中继（契约 §C）。
   * 线上编码尚未扩到这一段（`packages/shared` 的 borsh schema 还是 v3），这里先按可选透传：
   * 帧里没有解出 `undefined`，投影时保留上一次列表里的值。
   */
  viaRelay?: string | null;
  /** 该对端当前在线的全部中继地址；帧里没有为 `undefined`。 */
  relayPresence?: string[];
  /**
   * entry 本机暂停旗标。optional 尾字段：帧里没有 / option none 解出 `undefined`，
   * 投影时保留列表里已有的值；明确 `true` / `false` 才覆盖。
   */
  paused?: boolean;
  /** node.status 上报的 inventory（JSON 字符串已解析）；不可解析时保留原串。 */
  inventory: unknown;
  version?: string | null;
  direct_capable?: boolean | null;
  name?: string | null;
}

export interface RtcSignalPayload {
  rtcSession: string;
  from: 'browser' | 'node';
  to: string;
  sdp: string | null;
  candidate: string | null;
}

/** hub 收到 redeem 后经 entry 转发给发起页面的证书（设计 §2 步骤 3）。 */
export interface EnrollRedeemedPayload {
  /** base64url，32 字节：本次 enrollment 的公钥，页面据此匹配 pending。 */
  enrollPk: string;
  /** base64url(borsh(Certificate)) */
  certificate: string;
  /** base64url，64 字节 */
  certSig: string;
  /** 32 位小写 hex */
  nodeId: string;
}

export type MeshFrame =
  | { kind: 'node-event'; payload: NodeEventPayload }
  | { kind: 'rtc-signal'; payload: RtcSignalPayload }
  | { kind: 'enroll-redeemed'; payload: EnrollRedeemedPayload };

/** `ENROLL_REDEEMED`（B2-5）：线上是原始字节，页面侧一律转成 base64url 再走证书匹配。 */
export const KIND_ENROLL_REDEEMED = wsBorsh.KIND_ENROLL_REDEEMED;

/**
 * 枚举严格 allowlist：未知值一律让整帧作废。
 * 滚动升级时把未知 status 当成 `online`、把未知来源当成 `browser` 会把离线节点标成在线、
 * 把不明信令交给直连控制器（见 F4-3 评审 Minor）。
 */
function statusFromWire(status: number): NodeEventStatus | null {
  if (status === wsBorsh.NODE_EVENT_STATUS_ONLINE) return 'online';
  if (status === wsBorsh.NODE_EVENT_STATUS_OFFLINE) return 'offline';
  if (status === wsBorsh.NODE_EVENT_STATUS_REVOKED) return 'revoked';
  return null;
}

function fromFromWire(from: number): 'browser' | 'node' | null {
  if (from === wsBorsh.RTC_SIGNAL_FROM_BROWSER) return 'browser';
  if (from === wsBorsh.RTC_SIGNAL_FROM_NODE) return 'node';
  return null;
}

function reachFromWire(reach: string | null): NodeReach {
  return reach === 'lan' || reach === 'wan' || reach === 'relay' ? reach : null;
}

// 老 node 的帧里没有这两段，解出 `undefined`——与「新帧明确报告没有」（null）区分开，
// 投影时才知道该保留上一次轮询到的值还是清掉。
function transportFromWire(transport: unknown): NodeTransport | undefined {
  if (transport === undefined) return undefined;
  return transport === 'ws-secure' || transport === 'relay' || transport === 'dc'
    ? transport
    : null;
}

function rttFromWire(rttMs: unknown): number | null | undefined {
  if (rttMs === undefined) return undefined;
  return typeof rttMs === 'number' && Number.isFinite(rttMs) && rttMs >= 0 ? rttMs : null;
}

/**
 * 暂停旗标：只认明确的布尔值。`null` / 缺席解成 `undefined`，投影侧据此留用旧值。
 */
export function pausedFromWire(paused: unknown): boolean | undefined {
  if (paused === true) return true;
  if (paused === false) return false;
  return undefined;
}

/**
 * schema 尚未带 paused 时，从 NODE_EVENT 正文尾部读 optional bool。
 * 新 schema 已消费该字段时不要走这里（`pausedFromWire` 已给出结论）。
 *
 * 编码与 viaRelay 同一套 optional-tail：none = 单字节 0；Some(v) = 1 + bool。
 * 也兼容「只在有值时追加一个 bool」：单字节 1 = true。
 */
function pausedFromTrailing(raw: Uint8Array): boolean | undefined {
  try {
    const decoded = wsBorsh.decodeNodeEvent(raw);
    const without = wsBorsh.encodeNodeEvent(decoded);
    if (raw.length <= without.length) return undefined;
    const extra = raw.subarray(without.length);
    if (extra.length === 0 || extra[0] === 0) return undefined;
    if (extra[0] === 1 && extra.length === 1) return true;
    if (extra[0] === 1 && extra.length >= 2) return extra[1] === 1;
    return undefined;
  } catch {
    return undefined;
  }
}

function pausedFromDecoded(payload: { paused?: unknown }, raw: Uint8Array): boolean | undefined {
  const fromField = pausedFromWire(payload.paused);
  if (fromField !== undefined) return fromField;
  if (payload.paused === null) return undefined;
  return pausedFromTrailing(raw);
}

/**
 * 中继那两段（契约 §C）。线上是 `Option`，**没报告**与「报告了空」都编成 `null`——
 * 老 node 的帧、hub 模式、以及新 node 一时说不清走哪台，解出来是同一个值。分不开就一律按
 * 「没报告」处理：整个键不出现，投影侧的 `carry` / `pick` 据此留用列表里已有的值，
 * 而不是把一台好好的机器的中继信息抹成未知。
 *
 * 真正的「换了链路」由 `transport` 变化带出来，那条路径本来就会清掉这两段。
 * 名册是个数组，空数组是**确凿的**「一条中继都不在线」，与 `null` 区分得开，照原样带进去。
 */
export function relayFromWire(payload: { viaRelay?: unknown; relayPresence?: unknown }): {
  viaRelay?: string;
  relayPresence?: string[];
} {
  const out: { viaRelay?: string; relayPresence?: string[] } = {};
  const via = viaRelayOf(payload.viaRelay);
  if (via !== null) out.viaRelay = via;
  if (Array.isArray(payload.relayPresence)) {
    out.relayPresence = relayPresenceOf(payload.relayPresence);
  }
  return out;
}

function parseInventory(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * 解一帧 mesh WS 二进制；协议版本不符、未知枚举值、非 mesh kind 或畸形帧一律返回 `null`
 * （不抛，避免打断收流）。
 */
export function decodeMeshFrame(data: Uint8Array): MeshFrame | null {
  try {
    const envelope = wsBorsh.decodeEnvelope(data);
    if (envelope.version !== wsBorsh.CURRENT_VERSION) return null;
    if (envelope.kind === wsBorsh.KIND_NODE_EVENT) {
      // `transport` / `rttMs` / `viaRelay` / `relayPresence` 都是后加的线上字段：
      // 老 node（以及尚未扩容的 borsh schema）发来的帧里没有，解出为 undefined。
      const payload = wsBorsh.decodeNodeEvent(envelope.payload) as ReturnType<
        typeof wsBorsh.decodeNodeEvent
      > & {
        transport?: unknown;
        rttMs?: unknown;
        viaRelay?: unknown;
        relayPresence?: unknown;
        paused?: unknown;
      };
      const status = statusFromWire(payload.status);
      if (!status) return null;
      const paused = pausedFromDecoded(payload, envelope.payload);
      return {
        kind: 'node-event',
        payload: {
          nodeId: payload.nodeId,
          status,
          reach: reachFromWire(payload.reach),
          transport: transportFromWire(payload.transport),
          rttMs: rttFromWire(payload.rttMs),
          ...relayFromWire(payload),
          inventory: parseInventory(payload.inventory),
          version: payload.version,
          direct_capable: payload.directCapable,
          name: payload.name,
          ...(paused !== undefined ? { paused } : {}),
        },
      };
    }
    if (envelope.kind === wsBorsh.KIND_RTC_SIGNAL) {
      const payload = wsBorsh.decodePayload(wsBorsh.schema.RtcSignalSchema, envelope.payload);
      const from = fromFromWire(payload.from);
      if (!from) return null;
      return {
        kind: 'rtc-signal',
        payload: {
          rtcSession: payload.rtcSession,
          from,
          to: payload.to,
          sdp: payload.sdp,
          candidate: payload.candidate,
        },
      };
    }
    if (envelope.kind === KIND_ENROLL_REDEEMED) {
      const payload = wsBorsh.decodePayload(wsBorsh.schema.EnrollRedeemedSchema, envelope.payload);
      // 字段边界（`enroll_pk` 32 / `cert_sig` 64 / 证书上限 / `node_id` 32-hex）与 node、hub
      // 两侧共用同一份判定；不合规一律抛，由外层 catch 变成 `null`（帧作废）。
      wsBorsh.schema.assertEnrollRedeemedFields(payload);
      if (payload.certificate.length === 0) return null;
      return {
        kind: 'enroll-redeemed',
        payload: {
          enrollPk: encodeBase64url(payload.enrollPk),
          certificate: encodeBase64url(payload.certificate),
          certSig: encodeBase64url(payload.certSig),
          nodeId: payload.nodeId,
        },
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** 编一帧 RTC_SIGNAL（Phase 3 的 `DirectCarrierController` 用它上行）。 */
export function encodeRtcSignal(payload: RtcSignalPayload, seq = 0): Uint8Array {
  const body = wsBorsh.encodePayload(wsBorsh.schema.RtcSignalSchema, {
    rtcSession: payload.rtcSession,
    from: payload.from === 'node' ? wsBorsh.RTC_SIGNAL_FROM_NODE : wsBorsh.RTC_SIGNAL_FROM_BROWSER,
    to: payload.to,
    sdp: payload.sdp,
    candidate: payload.candidate,
  });
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_RTC_SIGNAL, body, seq);
}
