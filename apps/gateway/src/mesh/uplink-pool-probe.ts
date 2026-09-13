import type { PooledUplink } from './types';
import { isCurrentUplinkSession } from './uplink-nearest-switch';
import type { AttachedHub, UplinkCandidate, UplinkSwitchResult } from './uplink-pool';
import { redactUrl, sameHubUrl } from './uplink-pool-url';

export type PreferredProbeHost = {
  attachedHub(): AttachedHub | null;
  liveClient(): PooledUplink | null;
  candidates(): UplinkCandidate[];
  stopProbe(): void;
  probeHealthz(publicUrl: string): Promise<boolean>;
  drainCount(client: PooledUplink): number;
  waitDrain(client: PooledUplink): Promise<void>;
  switchTo(publicUrl: string): Promise<UplinkSwitchResult>;
  log(line: string): void;
  lastErrorOf(cand: UplinkCandidate): string | null;
  isLocalTransport(cand: UplinkCandidate): boolean;
  logSwitchBack(cand: UplinkCandidate, index: number): void;
};

/** healthz / probe 日志先于 drain；只有候选健康才等当前上行排空再 switch-back。 */
export async function runPreferredProbe(host: PreferredProbeHost): Promise<void> {
  const attached = host.attachedHub();
  const live = host.liveClient();
  if (!attached || live?.state !== 'online') return;
  const cands = host.candidates();
  const idx = cands.findIndex((row) => sameHubUrl(row.publicUrl, attached.publicUrl));
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
  attached: AttachedHub,
  pref: UplinkCandidate,
  index: number
): Promise<boolean> {
  const origin = redactUrl(pref.publicUrl);
  const ok = await host.probeHealthz(pref.publicUrl);
  if (!ok) {
    host.log(`[uplink] probe fail hub=${origin}`);
    return false;
  }
  host.log(`[uplink] probe ok hub=${origin}`);
  const streams = host.drainCount(live);
  host.log(
    `[uplink] probe waiting drain reason=switch-back streams=${streams} hub=${redactUrl(attached.publicUrl)}`
  );
  await host.waitDrain(live);
  if (
    !isCurrentUplinkSession(
      host.liveClient(),
      host.attachedHub(),
      { attached, live, best: pref },
      sameHubUrl
    )
  ) {
    return true;
  }
  const switched = await host.switchTo(pref.publicUrl);
  if (!switched.ok) return true;
  host.logSwitchBack(pref, index);
  return true;
}
