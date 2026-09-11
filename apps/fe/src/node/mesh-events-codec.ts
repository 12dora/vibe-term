// `/mesh/ws` 的帧编解码：NODE_EVENT / RTC_SIGNAL / ENROLL_REDEEMED 的线上表示与页面侧类型。
// 纯函数 + 类型，不碰连接状态（连接在 mesh-events.ts）。

import type { MeshNodeReach, MeshNodeTransport } from '@vibeterm/api-client/auth/index';
import { wsBorsh } from '@vibeterm/shared';
import { encodeBase64url } from '@vibeterm/shared/auth';

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
      // `transport` / `rttMs` 是后加的线上字段：老 node 发来的帧里没有，解出为 undefined。
      const payload = wsBorsh.decodeNodeEvent(envelope.payload) as ReturnType<
        typeof wsBorsh.decodeNodeEvent
      > & { transport?: unknown; rttMs?: unknown };
      const status = statusFromWire(payload.status);
      if (!status) return null;
      return {
        kind: 'node-event',
        payload: {
          nodeId: payload.nodeId,
          status,
          reach: reachFromWire(payload.reach),
          transport: transportFromWire(payload.transport),
          rttMs: rttFromWire(payload.rttMs),
          inventory: parseInventory(payload.inventory),
          version: payload.version,
          direct_capable: payload.directCapable,
          name: payload.name,
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
