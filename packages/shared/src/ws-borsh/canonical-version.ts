// canonical v1.1 的对端版本门槛。legacy state stream 删除后，v1.1 语义（ResizePaneV11、
// metadata 里的 tree order）是唯一通路，因此判定必须 fail-closed：拿不到版本或版本无法解析
// 一律视为不支持，宁可拒绝建 canonical 会话，也不要在对端静默丢帧。
//
// 唯一例外是开发态自报的 `X.Y.Z_dev`（见 formatDisplayVersion）：去掉后缀后按数字部分比较，
// 否则本地开发的网关与前端永远互相判定为不支持。

import { compareSemver } from '../semver';
import { ERROR_UNSUPPORTED_PROTOCOL } from './errors';

export const CANONICAL_V11_MIN_PEER_VERSION = '1.1.23';

const DEV_SUFFIX = '_dev';

export function peerSupportsCanonicalV11(version: string | null): boolean {
  if (version === null) return false;
  const trimmed = version.trim();
  const base = trimmed.endsWith(DEV_SUFFIX) ? trimmed.slice(0, -DEV_SUFFIX.length) : trimmed;
  const ordering = compareSemver(base, CANONICAL_V11_MIN_PEER_VERSION);
  return ordering !== null && ordering >= 0;
}

/**
 * 网关拒绝低于门槛的对端时，没有独立错误码可用（错误码表已冻结），只能复用
 * ERROR_UNSUPPORTED_PROTOCOL 并在 message 前缀里带上这串固定文本。前缀即契约：
 * 网关按此拼 message，客户端按此把 ERROR 帧翻成 `server-too-old`，两边都从这里取。
 */
export const CANONICAL_V11_REQUIRED_ERROR_PREFIX = 'canonical-state-v1.1 required';

/** 该 ERROR 帧是不是「对端版本低于 canonical v1.1 门槛」——不可重试，调用方应停止自动重连。 */
export function isCanonicalV11RequiredError(code: number, message: string): boolean {
  return (
    code === ERROR_UNSUPPORTED_PROTOCOL && message.startsWith(CANONICAL_V11_REQUIRED_ERROR_PREFIX)
  );
}

/** ERROR message 里对「谁太旧」的标注。gateway 侧只会写 client / node 两种。 */
export type CanonicalV11PeerSide = 'client' | 'node';

/** 节点编号或版本拿不到时 message 里的占位符。 */
export const CANONICAL_V11_UNKNOWN = 'unknown';

export interface CanonicalV11RequiredErrorInfo {
  side: CanonicalV11PeerSide;
  /** 被拒的远端节点编号；client 侧恒为 null。 */
  nodeId: string | null;
  /** 该端自报的版本；写成 unknown 或解不出时为 null。 */
  version: string | null;
}

/**
 * 拼 ERROR message，两种形态：
 * - `canonical-state-v1.1 required: node <nodeId> version <version> < <min>`
 * - `canonical-state-v1.1 required: client <version> < <min>`
 *
 * 入口网关拒老节点时浏览器并不知道被拒的是哪个节点（转发流的对端未必是当前 runtime 的
 * node），所以 node 形态必须把节点编号写进 message。网关拼、客户端解，共用这一个实现。
 */
export function formatCanonicalV11RequiredError(info: {
  side: CanonicalV11PeerSide;
  nodeId?: string | null;
  version: string | null;
}): string {
  const version = info.version ?? CANONICAL_V11_UNKNOWN;
  const suffix = `< ${CANONICAL_V11_MIN_PEER_VERSION}`;
  if (info.side === 'node') {
    const nodeId = info.nodeId ?? CANONICAL_V11_UNKNOWN;
    return `${CANONICAL_V11_REQUIRED_ERROR_PREFIX}: node ${nodeId} version ${version} ${suffix}`;
  }
  return `${CANONICAL_V11_REQUIRED_ERROR_PREFIX}: client ${version} ${suffix}`;
}

const NODE_ERROR_PATTERN = new RegExp(
  `^${CANONICAL_V11_REQUIRED_ERROR_PREFIX}: node (\\S+) version (\\S+) < `
);
const CLIENT_ERROR_PATTERN = new RegExp(
  `^${CANONICAL_V11_REQUIRED_ERROR_PREFIX}: client (\\S+) < `
);

function normalizeToken(raw: string | undefined): string | null {
  return raw === undefined || raw === CANONICAL_V11_UNKNOWN ? null : raw;
}

/**
 * 把该 ERROR 帧解析成「谁太旧 + 哪个节点 + 版本」。不是这类错误时返回 null，
 * 调用方据此决定弹哪条提示（节点 / Gateway / 本页面）。
 */
export function parseCanonicalV11RequiredError(
  code: number,
  message: string
): CanonicalV11RequiredErrorInfo | null {
  if (!isCanonicalV11RequiredError(code, message)) return null;
  const node = NODE_ERROR_PATTERN.exec(message);
  if (node) {
    return {
      side: 'node',
      nodeId: normalizeToken(node[1]),
      version: normalizeToken(node[2]),
    };
  }
  const client = CLIENT_ERROR_PATTERN.exec(message);
  if (!client) return null;
  return { side: 'client', nodeId: null, version: normalizeToken(client[1]) };
}
