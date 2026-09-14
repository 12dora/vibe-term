import type { PooledUplink } from './types';
import { isCurrentUplinkSession } from './uplink-nearest-switch';
import type { AttachedUplink, UplinkCandidate, UplinkSwitchResult } from './uplink-pool';
import { redactUrl, sameUplinkUrl } from './uplink-pool-url';

/** 与 `UPLINK_POOL_FAIL_LOG_INTERVAL_MS` 同值：probe fail/ok 按中继 URL 节流。 */
export const PROBE_LOG_INTERVAL_MS = 60_000;

export type PreferredProbeHost = {
  attachedUplink(): AttachedUplink | null;
  liveClient(): PooledUplink | null;
  candidates(): UplinkCandidate[];
  stopProbe(): void;
  probeHealthz(publicUrl: string): Promise<boolean>;
  drainCount(client: PooledUplink): number;
  waitDrain(client: PooledUplink): Promise<void>;
  switchTo(publicUrl: string): Promise<UplinkSwitchResult>;
  log(line: string): void;
  lastErrorOf(cand: UplinkCandidate): string | null;
  logSwitchBack(cand: UplinkCandidate, index: number): void;
  now?(): number;
  probeLogAt?: Map<string, number>;
};

/** healthz / probe 日志先于 drain；只有候选健康才等当前上行排空再 switch-back。 */
export async function runPreferredProbe(host: PreferredProbeHost): Promise<void> {
  const attached = host.attachedUplink();
  const live = host.liveClient();
  if (!attached || live?.state !== 'online') return;
  const cands = host.candidates();
  const idx = cands.findIndex((row) => sameUplinkUrl(row.publicUrl, attached.publicUrl));
  if (idx <= 0) {
    host.stopProbe();
    return;
  }
  for (let i = 0; i < idx; i += 1) {
    const pref = cands[i];
    if (!pref) continue;
    if (await switchPreferredIfHealthy(host, live, attached, pref, i)) return;
  }
}

async function switchPreferredIfHealthy(
  host: PreferredProbeHost,
  live: PooledUplink,
  attached: AttachedUplink,
  pref: UplinkCandidate,
  index: number
): Promise<boolean> {
  const origin = redactUrl(pref.publicUrl);
  const ok = await host.probeHealthz(pref.publicUrl);
  if (!ok) {
    if (allowProbeLog(host, `fail:${pref.publicUrl}`)) {
      host.log(`[uplink] probe fail url=${origin}`);
    }
    return false;
  }
  // 即将 drain + switch：probe ok 不节流。
  host.log(`[uplink] probe ok url=${origin}`);
  const streams = host.drainCount(live);
  host.log(
    `[uplink] probe waiting drain reason=switch-back streams=${streams} url=${redactUrl(attached.publicUrl)}`
  );
  await host.waitDrain(live);
  if (
    !isCurrentUplinkSession(
      host.liveClient(),
      host.attachedUplink(),
      { attached, live, best: pref },
      sameUplinkUrl
    )
  ) {
    return true;
  }
  const switched = await host.switchTo(pref.publicUrl);
  if (!switched.ok) return true;
  host.logSwitchBack(pref, index);
  return true;
}

function allowProbeLog(host: PreferredProbeHost, key: string): boolean {
  const now = host.now?.() ?? Date.now();
  const store = host.probeLogAt ?? sharedProbeLogAt;
  const prev = store.get(key) ?? Number.NEGATIVE_INFINITY;
  if (now - prev < PROBE_LOG_INTERVAL_MS) return false;
  store.set(key, now);
  return true;
}

const sharedProbeLogAt = new Map<string, number>();

export function resetProbeLogThrottleForTests(): void {
  sharedProbeLogAt.clear();
}
