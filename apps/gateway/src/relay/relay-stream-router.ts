import type { LinkStream } from '@tmex/shared/link';
import { type RelayQuota, decodeRelayOpenStream } from '@tmex/shared/relay';
import type { RelayMetering } from './relay-metering';
import type { RelayTokenBucket } from './relay-quota';
import type { RelayLiveNode, RelayRegistry } from './relay-registry';
import type { RelayTenantStore } from './relay-tenant-store';

const te = new TextEncoder();

export type RelayStreamContext = {
  registry: RelayRegistry;
  tenants: RelayTenantStore;
  metering: RelayMetering;
  quotaFor(tenantId: string): RelayQuota;
  bucketFor(tenantId: string): RelayTokenBucket;
  isStopped(): boolean;
};

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
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    ctx.registry.releaseStream(live.tenantId);
  };
  let outbound: LinkStream;
  try {
    outbound = await target.link.openStream(te.encode(JSON.stringify({ to, from: live.nodeId })));
  } catch {
    release();
    stream.reset('open-failed');
    return;
  }
  pumpRelayPair(ctx, live.tenantId, stream, outbound, release);
}

function pumpRelayPair(
  ctx: RelayStreamContext,
  tenantId: string,
  a: LinkStream,
  b: LinkStream,
  release: () => void
): void {
  let finished = false;
  const abortBoth = (): void => {
    if (finished) return;
    finished = true;
    release();
    try {
      a.reset('relay-rst');
    } catch {
      // already closed
    }
    try {
      b.reset('relay-rst');
    } catch {
      // already closed
    }
  };
  a.onAbort(abortBoth);
  b.onAbort(abortBoth);
  void Promise.all([
    pumpMetered(ctx, tenantId, a, b, abortBoth),
    pumpMetered(ctx, tenantId, b, a, abortBoth),
  ]).then(release, release);
}

async function pumpMetered(
  ctx: RelayStreamContext,
  tenantId: string,
  src: LinkStream,
  dst: LinkStream,
  onError: () => void
): Promise<void> {
  const reader = src.readable.getReader();
  try {
    while (!ctx.isStopped()) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const bytes = value.bytes;
      if (bytes.byteLength > 0) {
        // 读到即记账（转发前），一份中转字节在 in / out 各记一次
        ctx.metering.record(tenantId, {
          bytesIn: bytes.byteLength,
          bytesOut: bytes.byteLength,
        });
        await ctx.bucketFor(tenantId).take(bytes.byteLength);
      }
      if (bytes.byteLength > 0 || value.head) {
        await dst.write(bytes, value.head ? { head: true } : undefined);
      }
    }
    if (!ctx.isStopped()) await dst.end();
  } catch {
    onError();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}
