import { hostFromUrl } from '@vibeterm/shared/auth';
import type { RelayAutoSelectView, RelaySwitchReason } from '@vibeterm/shared/relay';
import { stamp } from './mesh-log';
import {
  RELAY_AUTO_SWITCH_DWELL_MS,
  type RelayConsiderResult,
  type RelayHysteresis,
  type RelayScoreInput,
  considerAutoSwitch,
  isConnectAuthFailure,
  resetRelayHysteresis,
  updateRttEwma,
} from './relay-best-select';
import { classifyRelayLinkError } from './relay-link-error';
import type { RelayPresence } from './relay-presence';
import type { SecondaryUplink } from './relay-secondary-attach';
import { runRelaySwitch } from './relay-switch-route';
import type { RelaySwitchDeps } from './relay-switch-route';
import type { RelayUplinkClient } from './relay-uplink-client';
import type { MeshScheduler, PooledUplink, UplinkState } from './types';
import { uplinkPathView } from './uplink-path-sampler';
import { normalizeUplinkEndpointUrl, sameUplinkUrl } from './uplink-pool-url';

export const RELAY_AUTO_HOLD_LOG_MS = 60_000;

export type RelayAutoSelectRow = {
  url: string;
  kicked: boolean;
};

export type RelayAutoSelectDeps = {
  scheduler: MeshScheduler;
  enabledSetting: boolean | null;
  intervalMs: number;
  rows: () => readonly RelayAutoSelectRow[];
  preferredUrl: () => string | null;
  currentUrl: () => string | null;
  liveClient: () => PooledUplink | null;
  primaryClient: () => RelayUplinkClient | null;
  secondaryOf: (url: string) => SecondaryUplink | null;
  presence: () => RelayPresence | null;
  probeHealthz: (url: string) => Promise<boolean>;
  waitForDrain: () => Promise<void>;
  switchDeps: () => RelaySwitchDeps;
  log?: (line: string) => void;
};

export class RelayAutoSelect {
  private readonly ewma = new Map<string, { ewma: number; samples: number }>();
  private readonly failureAt = new Map<string, number>();
  private hysteresis: RelayHysteresis = resetRelayHysteresis();
  private lastAutoSwitchAt = 0;
  private lastConsiderAt = 0;
  private lastSwitchAt: number | null = null;
  private switchReason: RelaySwitchReason | null = null;
  private pendingReason: RelaySwitchReason | null = null;
  private attachedOnce = false;
  private nextEvalAt: number | null = null;
  private lastHoldLogAt = 0;
  private lastScores = new Map<string, number | null>();
  private timer: { clear: () => void } | null = null;
  private evalInFlight = false;
  private rerun = false;
  private evalChain: Promise<void> = Promise.resolve();
  private coalesce = false;
  private running = false;

  constructor(private readonly deps: RelayAutoSelectDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.nextEvalAt = this.now() + this.deps.intervalMs;
    this.timer = this.deps.scheduler.interval(() => {
      this.nextEvalAt = this.now() + this.deps.intervalMs;
      void this.evaluate();
    }, this.deps.intervalMs);
  }

  stop(): void {
    this.running = false;
    this.timer?.clear();
    this.timer = null;
    this.nextEvalAt = null;
  }

  enabled(): boolean {
    if (this.deps.enabledSetting === false) return false;
    if (this.deps.enabledSetting === true) return true;
    return this.unkickedCount() >= 2;
  }

  view(): RelayAutoSelectView {
    return {
      enabled: this.enabled(),
      lastSwitchAt: this.lastSwitchAt,
      switchReason: this.switchReason,
      nextEvalAt: this.enabled() ? this.nextEvalAt : null,
    };
  }

  scoreOf(url: string): number | null {
    return this.lastScores.get(url) ?? null;
  }

  onRtt(url: string, rttMs: number | null): void {
    if (rttMs == null || rttMs < 0) return;
    this.feedRtt(url, rttMs);
    if (!this.running || this.inAutoDwell()) return;
    this.scheduleEval();
  }

  onKicked(url: string): void {
    this.failureAt.set(normalizeUplinkEndpointUrl(url), this.now());
    this.scheduleEval();
  }

  onStateChange(_state?: UplinkState): void {
    this.scheduleEval();
  }

  noteSwitch(reason: RelaySwitchReason | null): void {
    this.pendingReason = reason;
  }

  noteAttached(url: string): void {
    const reason = this.pendingReason ?? this.unsolicitedReason(url);
    this.pendingReason = null;
    this.attachedOnce = true;
    this.lastSwitchAt = this.now();
    this.switchReason = reason;
    this.lastAutoSwitchAt = this.lastSwitchAt;
  }

  evaluate(): Promise<void> {
    if (!this.running || !this.enabled()) return Promise.resolve();
    if (this.evalInFlight) {
      this.rerun = true;
      return this.evalChain;
    }
    this.evalInFlight = true;
    this.evalChain = this.runEvalLoop();
    return this.evalChain;
  }

  private async runEvalLoop(): Promise<void> {
    try {
      do {
        this.rerun = false;
        await this.evaluateOnce();
      } while (this.rerun && this.running && this.enabled());
    } finally {
      this.evalInFlight = false;
    }
  }

  private async evaluateOnce(): Promise<void> {
    const considered = this.snapshotConsider();
    this.applyConsidered(considered);
    const decision = considered.decision;
    if (decision.type === 'none') return;
    if (decision.type === 'hold') {
      this.logHold(decision);
      return;
    }
    await this.trySwitch(decision);
  }

  private async trySwitch(decision: {
    url: string;
    score: number;
    currentScore: number;
  }): Promise<void> {
    const live = this.deps.liveClient();
    const fromUrl = this.deps.currentUrl();
    if (!live || live.state !== 'online' || !fromUrl) return;
    await this.deps.waitForDrain();
    if (this.deps.liveClient() !== live || live.state !== 'online') return;
    const again = this.snapshotConsider();
    this.applyConsidered(again);
    if (again.decision.type !== 'switch' || !sameUplinkUrl(again.decision.url, decision.url))
      return;
    const healthy = await this.deps.probeHealthz(decision.url);
    if (!healthy) {
      this.logHold({
        reason: 'healthz',
        url: decision.url,
        score: decision.score,
        currentScore: decision.currentScore,
      });
      return;
    }
    this.noteSwitch('auto-rtt');
    const switched = await runRelaySwitch(this.deps.switchDeps(), decision.url, {
      persistPin: false,
    });
    if (!switched.ok) {
      this.noteSwitch(null);
      this.logHold({
        reason: 'switch-failed',
        url: decision.url,
        score: decision.score,
        currentScore: decision.currentScore,
      });
      return;
    }
    const at = this.now();
    this.lastAutoSwitchAt = at;
    this.lastSwitchAt = at;
    this.switchReason = 'auto-rtt';
    this.attachedOnce = true;
    this.pendingReason = null;
    this.log(
      `[relay][auto] switch from=${hostOf(fromUrl)} to=${hostOf(decision.url)} reason=auto-rtt score_from=${fmt(decision.currentScore)} score_to=${fmt(decision.score)}`
    );
  }

  private snapshotConsider(): RelayConsiderResult {
    this.seedMissingEwma();
    const rows = this.scoreInputs();
    return considerAutoSwitch({
      rows,
      currentUrl: this.deps.currentUrl(),
      preferredUrl: this.effectivePreferred(rows),
      lastAutoSwitchAt: this.lastAutoSwitchAt,
      now: this.now(),
      hysteresis: this.hysteresis,
      lastConsiderAt: this.lastConsiderAt,
      intervalMs: this.deps.intervalMs,
    });
  }

  private applyConsidered(considered: RelayConsiderResult): void {
    this.hysteresis = considered.hysteresis;
    this.lastScores = considered.scores;
    this.lastConsiderAt = considered.lastConsiderAt;
  }

  private scoreInputs(): RelayScoreInput[] {
    const primary = this.deps.primaryClient();
    const current = this.deps.currentUrl();
    this.collectClientFailures(current, primary);
    return this.deps.rows().map((row) => this.scoreInputFor(row, current, primary));
  }

  private collectClientFailures(current: string | null, primary: RelayUplinkClient | null): void {
    for (const row of this.deps.rows()) {
      const attached = current != null && sameUplinkUrl(current, row.url);
      const client = attached ? primary : this.deps.secondaryOf(row.url);
      this.noteClientFailure(row.url, client);
    }
  }

  private scoreInputFor(
    row: RelayAutoSelectRow,
    current: string | null,
    primary: RelayUplinkClient | null
  ): RelayScoreInput {
    const attached = current != null && sameUplinkUrl(current, row.url);
    const client = attached ? primary : this.deps.secondaryOf(row.url);
    const ewma = this.ewma.get(normalizeUplinkEndpointUrl(row.url));
    const path = uplinkPathView(row.url);
    return {
      url: row.url,
      online: client?.state === 'online' && !row.kicked,
      kicked: row.kicked,
      ewmaRtt: ewma?.ewma ?? null,
      rttSamples: ewma?.samples ?? 0,
      pathBestMs: path.pathBestMs ?? null,
      peersOnline: this.deps.presence()?.peersOnlineOn(row.url) ?? null,
      maxNodes: client?.quota?.maxNodes ?? null,
      lastFailureAt: this.failureAt.get(normalizeUplinkEndpointUrl(row.url)) ?? null,
    };
  }

  private seedMissingEwma(): void {
    const current = this.deps.currentUrl();
    const primary = this.deps.primaryClient();
    for (const row of this.deps.rows()) {
      const key = normalizeUplinkEndpointUrl(row.url);
      if (this.ewma.has(key)) continue;
      const attached = current != null && sameUplinkUrl(current, row.url);
      const rtt = attached ? primary?.rttMs : this.deps.secondaryOf(row.url)?.rttMs;
      if (rtt != null && rtt >= 0) this.feedRtt(row.url, rtt);
    }
  }

  private feedRtt(url: string, sample: number): void {
    const key = normalizeUplinkEndpointUrl(url);
    this.ewma.set(key, updateRttEwma(this.ewma.get(key) ?? null, sample));
  }

  private noteClientFailure(
    url: string,
    client: { lastConnectError: { reason: string; at: number } | null } | null
  ): void {
    const err = client?.lastConnectError;
    if (!err || !isConnectAuthFailure(classifyRelayLinkError(err.reason))) return;
    this.failureAt.set(normalizeUplinkEndpointUrl(url), err.at);
  }

  private effectivePreferred(rows: readonly RelayScoreInput[]): string | null {
    const preferred = this.deps.preferredUrl();
    if (!preferred) return null;
    const pin = rows.find((row) => sameUplinkUrl(row.url, preferred));
    return pin && !pin.kicked ? preferred : null;
  }

  private unsolicitedReason(url: string): RelaySwitchReason {
    if (!this.attachedOnce) return 'startup';
    const preferred = this.deps.preferredUrl();
    if (preferred && sameUplinkUrl(preferred, url)) return 'pin-failback';
    return 'auto-failover';
  }

  private scheduleEval(): void {
    if (!this.running || this.coalesce) return;
    this.coalesce = true;
    void this.deps.scheduler.sleep(0).then(
      () => {
        this.coalesce = false;
        void this.evaluate();
      },
      () => {
        this.coalesce = false;
      }
    );
  }

  private inAutoDwell(): boolean {
    return (
      this.lastAutoSwitchAt > 0 && this.now() - this.lastAutoSwitchAt < RELAY_AUTO_SWITCH_DWELL_MS
    );
  }

  private unkickedCount(): number {
    return this.deps.rows().filter((row) => !row.kicked).length;
  }

  private now(): number {
    return this.deps.scheduler.now();
  }

  private logHold(decision: {
    reason: string;
    url?: string;
    score?: number;
    currentScore?: number;
  }): void {
    const t = this.now();
    if (t - this.lastHoldLogAt < RELAY_AUTO_HOLD_LOG_MS) return;
    this.lastHoldLogAt = t;
    const from = hostOf(this.deps.currentUrl());
    const to = hostOf(decision.url ?? null);
    this.log(
      `[relay][auto] hold from=${from} to=${to} reason=${decision.reason} score_from=${fmt(decision.currentScore)} score_to=${fmt(decision.score)}`
    );
  }

  private log(line: string): void {
    (this.deps.log ?? defaultLog)(stamp(line));
  }
}

function hostOf(url: string | null): string {
  if (!url) return '-';
  try {
    return hostFromUrl(url);
  } catch {
    return url;
  }
}

function fmt(score: number | undefined): string {
  return score == null ? '-' : String(Math.round(score));
}

function defaultLog(line: string): void {
  console.info(line);
}
