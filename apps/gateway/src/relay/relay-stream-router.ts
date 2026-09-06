import type { LinkStream, StreamChunk } from '@tmex/shared/link';
import { type RelayQuota, decodeRelayOpenStream } from '@tmex/shared/relay';
import type { RelayBandwidthHandle } from './relay-bandwidth';
import type { RelayMetering } from './relay-metering';
import type { RelayTokenBucket, RelayTokenStream } from './relay-quota';
import { type RelayLiveNode, type RelayRegistry, noteRelayByteFlow } from './relay-registry';
import type { RelayTenantStore } from './relay-tenant-store';

const te = new TextEncoder();

export type RelayStreamContext = {
  registry: RelayRegistry;
  tenants: RelayTenantStore;
  metering: RelayMetering;
  quotaFor(tenantId: string): RelayQuota;
  bucketFor(tenantId: string): RelayTokenBucket;
  /** 中继级总带宽闸；租户桶放行后还要过这一道。 */
  bandwidthFor(tenantId: string): RelayBandwidthHandle;
  now(): number;
  isStopped(): boolean;
};

type RelayRstReason = 'relay-rst:src-read' | 'relay-rst:dst-write' | 'relay-rst:peer-abort';

/**
 * relay 流首帧只带 `{to}`；中继校验同租户 + 双方 admitted + 并发流配额后，
 * 以 `{to, from}` 打开目标流并双向 pump（超带宽只延迟，不丢帧）。
 */
export async function acceptRelayStream(
  ctx: RelayStreamContext,
  live: RelayLiveNode,
  stream: LinkStream
): Promise<void> {
  let to: string;
  try {
    to = decodeRelayOpenStream(stream.openPayload).to;
  } catch {
    stream.reset('invalid-relay');
    return;
  }
  if (to === live.nodeId) {
    stream.reset('self-target');
    return;
  }
  const targetRow = ctx.tenants.getNode(live.tenantId, to);
  if (!targetRow || targetRow.status !== 'admitted') {
    stream.reset('unknown-target');
    return;
  }
  const target = ctx.registry.get(live.tenantId, to);
  if (!target) {
    stream.reset('offline');
    return;
  }
  const quota = ctx.quotaFor(live.tenantId);
  // 先占位再 await：openStream 是异步的，检查放在它后面会让并发 OPEN 一起穿过配额
  if (!ctx.registry.reserveStream(live.tenantId, quota.maxStreams)) {
    stream.reset('quota-streams');
    return;
  }
  const sourceId = live.nodeId;
  ctx.registry.reserveMemberPair(live.tenantId, sourceId, to);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    ctx.registry.releaseStream(live.tenantId);
    ctx.registry.releaseMemberPair(live.tenantId, sourceId, to);
  };
  let outbound: LinkStream;
  try {
    outbound = await target.link.openStream(te.encode(JSON.stringify({ to, from: live.nodeId })));
  } catch {
    release();
    stream.reset('open-failed');
    return;
  }
  pumpRelayPair(ctx, live.tenantId, live, target, stream, outbound, release);
}

function pumpRelayPair(
  ctx: RelayStreamContext,
  tenantId: string,
  source: RelayLiveNode,
  target: RelayLiveNode,
  a: LinkStream,
  b: LinkStream,
  release: () => void
): void {
  let finished = false;
  const limiter = ctx.bucketFor(tenantId).createStream();
  const global = ctx.bandwidthFor(tenantId);
  const abortBoth = (reason: RelayRstReason): void => {
    if (finished) return;
    finished = true;
    limiter.close();
    global.close();
    release();
    try {
      a.reset(reason);
    } catch {
      // already closed
    }
    try {
      b.reset(reason);
    } catch {
      // already closed
    }
  };
  a.onAbort(() => abortBoth('relay-rst:peer-abort'));
  b.onAbort(() => abortBoth('relay-rst:peer-abort'));
  const finish = (): void => {
    if (finished) return;
    finished = true;
    limiter.close();
    global.close();
    release();
  };
  void Promise.all([
    pumpMetered(ctx, tenantId, source, target, a, b, limiter, global, abortBoth),
    pumpMetered(ctx, tenantId, target, source, b, a, limiter, global, abortBoth),
  ]).then(finish, finish);
}

async function pumpMetered(
  ctx: RelayStreamContext,
  tenantId: string,
  from: RelayLiveNode,
  to: RelayLiveNode,
  src: LinkStream,
  dst: LinkStream,
  limiter: RelayTokenStream,
  global: RelayBandwidthHandle,
  onError: (reason: RelayRstReason) => void
): Promise<void> {
  const reader = src.readable.getReader();
  try {
    while (!ctx.isStopped()) {
      let chunk: { done: boolean; value?: StreamChunk };
      try {
        chunk = await reader.read();
      } catch {
        await halfCloseOrAbort(dst, onError, 'relay-rst:src-read');
        return;
      }
      const { done, value } = chunk;
      if (done) break;
      if (!value) continue;
      const bytes = value.bytes;
      if (bytes.byteLength > 0) {
        noteRelayByteFlow(from, ctx.now());
        // 读到即记账（转发前）。租户 in/out 各记一次；成员按方向：源 bytesIn、目标 bytesOut。
        ctx.metering.record(tenantId, {
          bytesIn: bytes.byteLength,
          bytesOut: bytes.byteLength,
        });
        ctx.metering.recordMember(tenantId, from.nodeId, { bytesIn: bytes.byteLength });
        ctx.metering.recordMember(tenantId, to.nodeId, { bytesOut: bytes.byteLength });
        try {
          // 先过租户闸再过中继闸：超了自家额度的租户不该在全局轮转里占位。
          await limiter.take(bytes.byteLength);
          await global.take(bytes.byteLength);
          ctx.metering.recordAdmitted(tenantId, bytes.byteLength);
        } catch {
          await halfCloseOrAbort(dst, onError, 'relay-rst:dst-write');
          return;
        }
      }
      if (bytes.byteLength > 0 || value.head) {
        try {
          await dst.write(bytes, value.head ? { head: true } : undefined);
          if (bytes.byteLength > 0) noteRelayByteFlow(to, ctx.now());
        } catch {
          await halfCloseOrAbort(dst, onError, 'relay-rst:dst-write');
          return;
        }
      }
    }
    if (!ctx.isStopped()) {
      try {
        await dst.end();
      } catch {
        onError('relay-rst:dst-write');
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

async function halfCloseOrAbort(
  dst: LinkStream,
  onError: (reason: RelayRstReason) => void,
  reason: RelayRstReason
): Promise<void> {
  try {
    await dst.end();
  } catch {
    onError(reason);
  }
}
