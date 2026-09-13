import { RELAY_RECORD_TYPES, decodeBase64url, decodeKeyLogRecord } from '@vibeterm/shared/auth';
import { FORCE_KEYLOG_HEADER, readHeaderPair } from '@vibeterm/shared/http/mesh-headers';
import { readJsonObjectBody } from '../api/http';
import { requiredStrings } from '../api/route-input';

/**
 * `set-relays` / `meta-key` 定义的是上级本身：首次接中继时还没有中继可问，被踢之后旧令牌已死，
 * hub → 中继迁移更不该要求旧 hub 认得这个类型。这两类记录一律本地优先落账。
 */
const UPLINK_DEFINING_RECORDS: ReadonlySet<string> = new Set<string>(RELAY_RECORD_TYPES);

export function definesUplink(bytes: Uint8Array): boolean {
  try {
    return UPLINK_DEFINING_RECORDS.has(decodeKeyLogRecord(bytes).type);
  } catch {
    return false;
  }
}

export type KeyLogAppendPlan = {
  /** 本地日志权威：先落账再推给上级，上级确认不影响本地提交。 */
  localFirst: boolean;
  /** 是否把记录发给当前上级（迁移中的 set-relays 不能回灌旧 hub）。 */
  publish: boolean;
};

/**
 * 中继模式下本地成员表/密钥日志是权威，先本地提交，再通过 relayAck 单独报告中继确认。
 * hub 模式只有 `set-relays` / `meta-key` 走本地优先。`readmit-node` 与 `admit-node` 一样：
 * 任意模式都 publish；hub 模式走 writer（`localFirst: false`）。
 */
export function planKeyLogAppend(input: {
  relayMode: boolean;
  bytes: Uint8Array;
}): KeyLogAppendPlan {
  const defining = definesUplink(input.bytes);
  return { localFirst: input.relayMode || defining, publish: input.relayMode || !defining };
}

export async function readKeyLogAppend(
  req: Request
): Promise<{ bytes: Uint8Array; sig: Uint8Array; force: boolean } | null> {
  const body = await readJsonObjectBody(req);
  const fields = body && requiredStrings(body, ['bytes', 'sig']);
  if (!fields) return null;
  try {
    return {
      bytes: decodeBase64url(fields.bytes),
      sig: decodeBase64url(fields.sig),
      force: readHeaderPair(req.headers, FORCE_KEYLOG_HEADER) === '1',
    };
  } catch {
    return null;
  }
}
