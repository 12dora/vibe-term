import type { LinkStream } from '@vibeterm/shared/link';
import { headersFrom, resumePlanFrom } from './http-resume-plan';
import { flushOptimisationRetire } from './peer-optimisation-retire';
import type { LivePeer } from './peer-reconnect-wake';

const liveOfStream = new WeakMap<LinkStream, LivePeer>();
const nonMigratableStreams = new WeakSet<LinkStream>();
const releasedStreams = new WeakSet<LinkStream>();

export function trackLiveHttpStream(live: LivePeer, stream: LinkStream, now: number): void {
  liveOfStream.set(stream, live);
  live.streams += 1;
  live.lastStreamAt = now;
  live.zeroStreamsSince = 0;
}

/**
 * HTTP 响应头已知且不可 Range 续传时记账。入口在收到 head 时调，
 * 远端在写入 head 时调；关闭走与 live.streams 同一条 stream.closed。
 * 只认 onStreamOpened 登记过的流；已 release 的晚到 head 忽略。
 */
export function noteHttpResponseHead(
  stream: LinkStream,
  method: string,
  status: number,
  headers: Headers | Record<string, string>
): void {
  if (releasedStreams.has(stream)) return;
  const live = liveOfStream.get(stream);
  if (!live) return;
  if (resumePlanFrom(method, status, headersFrom(headers))) return;
  if (nonMigratableStreams.has(stream)) return;
  nonMigratableStreams.add(stream);
  live.nonMigratable = (live.nonMigratable ?? 0) + 1;
}

export function releaseLiveHttpStream(
  live: LivePeer,
  stream: LinkStream,
  now: number,
  finishRetire: (live: LivePeer, reason: string) => void
): number {
  releasedStreams.add(stream);
  live.streams = Math.max(0, live.streams - 1);
  live.lastStreamAt = now;
  if (nonMigratableStreams.has(stream)) {
    nonMigratableStreams.delete(stream);
    live.nonMigratable = Math.max(0, (live.nonMigratable ?? 1) - 1);
  }
  flushOptimisationRetire(live, finishRetire);
  if (live.streams === 0) live.zeroStreamsSince = now;
  return live.streams;
}
