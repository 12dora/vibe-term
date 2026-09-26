import {
  LOGIN_RECORD_CLIENT_HEADER,
  LOGIN_RECORD_ENTRY_CLIENT_IP_HEADER,
  type LoginRecordClient,
  type LoginRecordKind,
  type LoginRecordMethod,
  type LoginRecordSecond,
} from '@vibeterm/shared';
import { decodeBase64url, decodeDelegation } from '@vibeterm/shared/auth';
import { parseIpLiteral } from '../mesh/address-class';
import { clientIpFromRequest } from '../mesh/client-ip';
import { isPeerRequest } from '../mesh/client-source';
import { MESH_VIA_SELF } from '../mesh/mesh-deps';

const UA_MAX = 512;

export function readLoginClient(req: Request): LoginRecordClient {
  const value = req.headers.get(LOGIN_RECORD_CLIENT_HEADER)?.trim().toLowerCase();
  if (value === 'web' || value === 'cli') return value;
  return 'unknown';
}

export function readLoginUserAgent(req: Request): string | null {
  return clipHeader(req.headers.get('user-agent'), UA_MAX);
}

export function readLoginOrigin(req: Request): string | null {
  const header = clipHeader(req.headers.get('origin'), UA_MAX);
  if (header) return header;
  try {
    return clipHeader(new URL(req.url).origin, UA_MAX);
  } catch {
    return null;
  }
}

export function loginRecordKind(via: string | null | undefined, nodeId: string): LoginRecordKind {
  if (!via || via === MESH_VIA_SELF || via === nodeId) return 'interactive';
  return 'background';
}

export function loginRecordViaNodeId(
  via: string | null | undefined,
  nodeId: string
): string | null {
  if (!via || via === MESH_VIA_SELF || via === nodeId) return nodeId || null;
  return via;
}

/**
 * 直连登录用套接字解析出的客户端 IP。peer 入站只在调用方确认入口版本
 * ≥ 2.10.0 时信 `x-vibeterm-entry-client-ip`；其它请求上的同名头直接丢掉。
 */
export function loginRecordIp(req: Request, trustEntryIp = false): string | null {
  if (!isPeerRequest(req)) {
    req.headers.delete(LOGIN_RECORD_ENTRY_CLIENT_IP_HEADER);
    return parseIpLiteral(clientIpFromRequest(req)) ?? null;
  }
  if (!trustEntryIp) {
    req.headers.delete(LOGIN_RECORD_ENTRY_CLIENT_IP_HEADER);
    return null;
  }
  const header = req.headers.get(LOGIN_RECORD_ENTRY_CLIENT_IP_HEADER) ?? undefined;
  return parseIpLiteral(header) ?? null;
}

export function peekLoginMethod(body: Record<string, unknown>): LoginRecordMethod | null {
  if (typeof body.delegation !== 'string' || body.delegation.length === 0) return null;
  try {
    const method = decodeDelegation(decodeBase64url(body.delegation)).method;
    if (method === 'root' || method === 'passkey') return method;
    return null;
  } catch {
    return null;
  }
}

export function secondFromFailureCode(code: string): LoginRecordSecond | null {
  if (code === 'TOTP_INVALID') return 'totp';
  if (code === 'PASSKEY_INVALID') return 'passkey';
  return null;
}

function clipHeader(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}
