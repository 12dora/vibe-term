// 一次性登录命令的编码与派生。浏览器生成、CLI 兑换、网关只见每节点派生码的哈希。
//
//   命令码  = "vtl1_" + base64url(secret[16] ‖ nodeId[16] × n)
//   节点码  = HMAC-SHA256(secret, "vibeterm/login-code/v1\0" ‖ nodeIdHex)
//   服务端  只存 sha256(节点码)；兑换时 CLI 只把该节点自己的节点码发给它。

import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { concatBytes, decodeBase64url, encodeBase64url } from './encoding';

export const LOGIN_CODE_PREFIX = 'vtl1_';
export const LOGIN_CODE_SECRET_BYTES = 16;
export const LOGIN_CODE_NODE_CODE_BYTES = 32;
export const LOGIN_CODE_MAX_NODES = 64;
/** 命令码自生成起的有效期；每台节点各自按登记时刻计时。 */
export const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;
/** 未经新验证码校验时，委托必须是这段时间内新签的（现场输入密码或通行密钥）。 */
export const LOGIN_CODE_FRESH_DELEGATION_MS = 5 * 60 * 1000;
/** 低于该版本的节点没有登录命令接口。 */
export const MIN_LOGIN_CODE_VERSION = '2.17.0';

const NODE_ID_BYTES = 16;
const NODE_ID_HEX = /^[0-9a-f]{32}$/;
const DERIVE_DOMAIN = utf8ToBytes('vibeterm/login-code/v1\0');
const CODE_BODY = /^[A-Za-z0-9_-]+$/;

export interface LoginCodeParts {
  secret: Uint8Array;
  /** 32 位小写十六进制 mesh 节点 id，保持生成时的顺序、去重。 */
  nodeIds: string[];
}

export function generateLoginCodeSecret(): Uint8Array {
  const secret = new Uint8Array(LOGIN_CODE_SECRET_BYTES);
  globalThis.crypto.getRandomValues(secret);
  return secret;
}

export function encodeLoginCode(parts: LoginCodeParts): string {
  if (parts.secret.length !== LOGIN_CODE_SECRET_BYTES) {
    throw new Error(`login code secret must be ${LOGIN_CODE_SECRET_BYTES} bytes`);
  }
  const ids = [...new Set(parts.nodeIds)];
  if (ids.length === 0 || ids.length > LOGIN_CODE_MAX_NODES) {
    throw new Error('login code must name 1..64 nodes');
  }
  for (const id of ids) {
    if (!NODE_ID_HEX.test(id)) throw new Error(`invalid node id: ${id}`);
  }
  return LOGIN_CODE_PREFIX + encodeBase64url(concatBytes(parts.secret, ...ids.map(hexToBytes)));
}

/** 解析失败一律返回 null（格式、长度、节点数、重复节点）。 */
export function decodeLoginCode(input: string): LoginCodeParts | null {
  const text = input.trim();
  if (!text.startsWith(LOGIN_CODE_PREFIX)) return null;
  const body = text.slice(LOGIN_CODE_PREFIX.length);
  if (!CODE_BODY.test(body)) return null;
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64url(body);
  } catch {
    return null;
  }
  const rest = bytes.length - LOGIN_CODE_SECRET_BYTES;
  if (rest <= 0 || rest % NODE_ID_BYTES !== 0) return null;
  const count = rest / NODE_ID_BYTES;
  if (count > LOGIN_CODE_MAX_NODES) return null;
  const nodeIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const start = LOGIN_CODE_SECRET_BYTES + i * NODE_ID_BYTES;
    nodeIds.push(bytesToHex(bytes.subarray(start, start + NODE_ID_BYTES)));
  }
  if (new Set(nodeIds).size !== nodeIds.length) return null;
  return { secret: bytes.slice(0, LOGIN_CODE_SECRET_BYTES), nodeIds };
}

/** 某台节点专属的兑换码：拿到它的节点推不出别的节点的码。 */
export function deriveNodeLoginCode(secret: Uint8Array, nodeId: string): Uint8Array {
  if (!NODE_ID_HEX.test(nodeId)) throw new Error(`invalid node id: ${nodeId}`);
  return hmac(sha256, secret, concatBytes(DERIVE_DOMAIN, utf8ToBytes(nodeId)));
}

export function loginCodeHash(nodeCode: Uint8Array): Uint8Array {
  return sha256(nodeCode);
}

export function loginCodeHashHex(nodeCode: Uint8Array): string {
  return bytesToHex(loginCodeHash(nodeCode));
}
