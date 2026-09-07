import { RELAY_KEYLOG_MAX_PAGES } from '../../../../apps/gateway/src/mesh/relay-key-log-sync';
import { bytesEqual, encodeBase64url } from '../../../shared/src/auth';
import { RELAY_TOKEN_HEADER, assignHeaderPair } from '../../../shared/src/http/mesh-headers';
import { openRelayKeyLogRecord } from '../../../shared/src/relay';
import { joinRelayUrl, requestRelayJson } from '../commands/relay-shared';
import type { FetchLike } from './fetch-like';
import type { LocalAuthContext } from './local-auth';
import { type RelayKeyLogPageItem, parseRelayKeyLogPage } from './relay-keylog';
import { appendOneJoinRecord, isRelaySeqMismatch } from './relay-password-join-append';

type PackSyncInput = {
  ctx: LocalAuthContext;
  userId: string;
  relayUrl: string;
  tenantId: string;
  token: Uint8Array;
  logKey: Uint8Array;
  headSeq: bigint;
  fetcher?: FetchLike;
};

async function readPage(input: PackSyncInput, from: bigint, limit: number) {
  const body = await requestRelayJson({
    fetcher: input.fetcher,
    url: joinRelayUrl(
      input.relayUrl,
      `/api/relay/tenants/${input.tenantId}/keylog?from_seq=${from}&limit=${limit}`
    ),
    headers: assignHeaderPair({}, RELAY_TOKEN_HEADER, encodeBase64url(input.token)),
    label: 'relay key log sync',
  });
  if (!Array.isArray(body.key_log)) throw new Error('relay key log response missing records');
  return { records: parseRelayKeyLogPage(body.key_log), hasMore: body.has_more === true };
}

async function verifyRecord(input: PackSyncInput, item: RelayKeyLogPageItem): Promise<void> {
  const local = input.ctx.keyLogStore.getAtSeq(input.userId, Number(item.seq));
  const remote = await openRelayKeyLogRecord(input.logKey, item.blob);
  if (!local || !bytesEqual(local.bytes, remote.bytes) || !bytesEqual(local.sig, remote.sig)) {
    throw new Error(`relay key log fork at seq ${item.seq}`);
  }
}

async function recordIsPublished(input: PackSyncInput, seq: bigint): Promise<boolean> {
  const page = await readPage(input, seq, 1);
  const record = page.records.find((item) => BigInt(item.seq) === seq);
  if (!record) return false;
  await verifyRecord(input, record);
  return true;
}

async function readRemotePrefix(input: PackSyncInput): Promise<bigint> {
  let cursor = 0n;
  for (let pageIndex = 0; pageIndex < RELAY_KEYLOG_MAX_PAGES; pageIndex += 1) {
    const page = await readPage(input, cursor + 1n, 64);
    for (const item of page.records) {
      if (BigInt(item.seq) !== cursor + 1n) throw new Error('relay key log is not contiguous');
      await verifyRecord(input, item);
      cursor += 1n;
      if (cursor === input.headSeq) return cursor;
    }
    if (!page.hasMore) return cursor;
    if (page.records.length === 0) throw new Error('relay key log sync stalled');
  }
  throw new Error('relay key log sync page limit exceeded');
}

async function publishMissing(input: PackSyncInput, remoteHead: bigint): Promise<void> {
  let cursor = remoteHead;
  for (let page = 0; cursor < input.headSeq && page < RELAY_KEYLOG_MAX_PAGES; page += 1) {
    const records = input.ctx.keyLogStore.list(input.userId, Number(cursor + 1n), 64);
    if (records.length === 0) break;
    for (const record of records) {
      if (BigInt(record.seq) > input.headSeq) return;
      try {
        await appendOneJoinRecord({ ...input, record });
      } catch (error) {
        if (!isRelaySeqMismatch(error)) throw error;
        if (!(await recordIsPublished(input, BigInt(record.seq)))) throw error;
      }
      cursor = BigInt(record.seq);
    }
  }
  if (cursor < input.headSeq) throw new Error('relay key log sync did not reach the pack head');
}

/** 复用密码加入的发布路径；与活跃 uplink 并发写入时按记录内容确认，不能只信远端 seq。 */
export async function syncRelayPackHead(input: PackSyncInput): Promise<void> {
  if (input.headSeq === 0n || (await recordIsPublished(input, input.headSeq))) return;
  const remoteHead = await readRemotePrefix(input);
  await publishMissing(input, remoteHead);
  if (!(await recordIsPublished(input, input.headSeq))) {
    throw new Error('relay key log sync did not reach the pack head');
  }
}
