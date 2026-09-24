import { rtcLog } from './rtc-log';
import type { LocalDescriptionFanout } from './rtc-peer-helpers';
import { isFakeIpv4IceCandidate } from './rtc-signal-apply';

/** 去掉 SDP 里的 198.18.0.0/15 host。探测提前 gather 时，answer 会把这些候选内联进去，绕过 trickle 过滤。 */
export function stripFakeIpSdpCandidates(sdp: string): { sdp: string; dropped: number } {
  const nl = sdp.includes('\r\n') ? '\r\n' : '\n';
  let dropped = 0;
  const kept: string[] = [];
  for (const line of sdp.split(/\r?\n/)) {
    if (isFakeCandidateLine(line)) {
      dropped += 1;
      continue;
    }
    kept.push(line);
  }
  return { sdp: kept.join(nl), dropped };
}

export function publishLocalDescription(
  fanout: LocalDescriptionFanout,
  sdp: string,
  type: string
): void {
  const stripped = stripFakeIpSdpCandidates(sdp);
  if (stripped.dropped > 0) {
    rtcLog('signal dropped', { kind: 'sdp', cause: 'fake-ip', dropped: stripped.dropped });
  }
  const description = { sdp: stripped.sdp, type };
  fanout.latest = description;
  for (const listener of fanout.listeners) listener(description);
}

function isFakeCandidateLine(line: string): boolean {
  const trimmed = line.trim();
  return /^a=candidate:/i.test(trimmed) && isFakeIpv4IceCandidate(trimmed);
}
