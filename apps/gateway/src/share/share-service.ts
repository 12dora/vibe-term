import type { StateSnapshotPayload } from '@tmex/shared';
import {
  SHARE_DEFAULT_SETTINGS,
  SHARE_PASSWORD_MIN_LENGTH,
  type ShareEndReason,
  type ShareLogPage,
  type ShareRecord,
  type ShareScope,
  type ShareSettings,
  buildShareUrl,
  isPublicShareOrigin,
  normalizeShareOrigin,
} from '@tmex/shared/share';
import { getDeviceById } from '../db';
import { tmuxRuntimeRegistry } from '../tmux-client/registry';
import { getDeviceSnapshot } from '../tmux/snapshot-directory';
import {
  type ShareOriginContext,
  type ShareOriginSources,
  buildShareOriginContext,
  defaultShareOriginSources,
  resolveSharePrefix,
} from './share-origins';
import { ShareLoginLimiter } from './share-rate-limit';
import { ShareRecorder, type ShareRecorderRuntime, hasWindow } from './share-recorder';
import {
  accessExpiry,
  clampInt,
  defaultAcquireRuntime,
  defaultReleaseRuntime,
  normalizeDefaultOrigin,
} from './share-service-support';
import {
  type ShareLogAppend,
  type ShareRow,
  ShareStore,
  hashSharePassword,
  verifySharePassword,
} from './share-store';
import {
  SHARE_ACCESS_TTL_MS,
  generateShareId,
  generateShareToken,
  hashShareToken,
  parseShareToken,
} from './share-token';
import type {
  ShareCreateInput,
  ShareCreateResult,
  ShareEndedEvent,
  ShareListFilter,
  ShareListResult,
  ShareLoginResult,
  ShareOriginsView,
  ShareService,
  ShareServiceDeps,
  ShareViewerCounter,
  VerifiedShareAccess,
} from './types';

export type { ShareService, ShareServiceDeps } from './types';

export const SHARE_WATCH_INTERVAL_MS = 5_000;
export const SHARE_RETENTION_SWEEP_MS = 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_000;

class ShareServiceImpl implements ShareService {
  private readonly store: ShareStore;
  private readonly now: () => number;
  private readonly limiter: ShareLoginLimiter;
  private readonly listeners = new Set<(event: ShareEndedEvent) => void>();
  private readonly recorders = new Map<string, ShareRecorder>();
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private viewerCounter: ShareViewerCounter | null = null;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private retentionTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly deps: ShareServiceDeps = {}) {
    this.store = deps.store ?? new ShareStore();
    this.now = deps.now ?? Date.now;
    this.limiter = new ShareLoginLimiter(this.now);
  }

  private snapshotOf(deviceId: string): StateSnapshotPayload | null {
    if (this.deps.snapshotOf) return this.deps.snapshotOf(deviceId);
    for (const recorder of this.recorders.values()) {
      if (recorder.deviceId !== deviceId) continue;
      const snapshot = recorder.snapshot();
      if (snapshot) return snapshot;
    }
    return getDeviceSnapshot(deviceId);
  }

  private deviceExists(deviceId: string): boolean {
    if (this.deps.deviceExists) return this.deps.deviceExists(deviceId);
    try {
      return Boolean(getDeviceById(deviceId));
    } catch {
      return false;
    }
  }

  private originContext(): ShareOriginContext {
    const settings = this.store.getSettings();
    return buildShareOriginContext(
      this.deps.originSources ?? defaultShareOriginSources,
      settings.defaultOrigin
    );
  }

  private toRecord(row: ShareRow): ShareRecord {
    const viewers = row.state === 'active' ? (this.viewerCounter?.(row.id) ?? 0) : 0;
    return {
      id: row.id,
      name: row.name,
      deviceId: row.deviceId,
      windowId: row.windowId,
      windowName: row.windowName,
      state: row.state,
      endReason: row.endReason,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      endedAt: row.endedAt,
      origin: row.origin,
      url: row.url,
      viewers,
      logBytes: row.logBytes,
      logTruncated: row.logTruncated,
      recordLog: row.recordLog,
    };
  }

  async create(input: ShareCreateInput): Promise<ShareCreateResult> {
    const password = input.password ?? '';
    if (password.length < SHARE_PASSWORD_MIN_LENGTH) {
      return { ok: false, code: 'SHARE_PASSWORD_TOO_SHORT' };
    }
    const snapshot = this.snapshotOf(input.deviceId);
    const window = snapshot?.session?.windows.find((item) => item.id === input.windowId);
    if (!window) return { ok: false, code: 'SHARE_WINDOW_NOT_FOUND' };

    const context = this.originContext();
    const origin = normalizeShareOrigin(input.origin ?? '') ?? context.candidates[0]?.url ?? null;
    if (!origin || !isPublicShareOrigin(origin)) {
      return { ok: false, code: 'SHARE_ORIGIN_INVALID' };
    }

    const settings = this.store.getSettings();
    const now = this.now();
    const id = generateShareId();
    const windowName = window.customName?.trim() || window.name;
    const row: ShareRow = {
      id,
      name: input.name?.trim() || windowName,
      deviceId: input.deviceId,
      windowId: input.windowId,
      windowName,
      state: 'active',
      endReason: null,
      origin,
      url: buildShareUrl(origin, resolveSharePrefix(context, origin), id),
      recordLog: settings.recordLogs,
      logBytes: 0,
      logTruncated: false,
      logSeq: 0,
      logPurgedAt: null,
      createdAt: now,
      expiresAt: input.expiresInMs === null ? null : now + Math.max(0, input.expiresInMs),
      endedAt: null,
    };
    const hash = await (this.deps.hashPassword ?? hashSharePassword)(password);
    this.store.insert({ ...row, passwordHash: hash });
    this.scheduleExpiry(row);
    void this.startRecorder(row);
    return { ok: true, share: this.toRecord(row), password };
  }

  list(filter?: ShareListFilter): ShareListResult {
    const rows = this.store.list(filter);
    const active: ShareRecord[] = [];
    const history: ShareRecord[] = [];
    for (const row of rows) {
      (row.state === 'active' ? active : history).push(this.toRecord(row));
    }
    return { active, history };
  }

  get(id: string): ShareRecord | null {
    const row = this.store.get(id);
    return row ? this.toRecord(row) : null;
  }

  revoke(id: string): ShareRecord | null {
    return this.endShare(id, 'revoked');
  }

  remove(id: string): boolean {
    return this.store.remove(id);
  }

  endShare(id: string, reason: ShareEndReason): ShareRecord | null {
    const existing = this.store.get(id);
    if (!existing) return null;
    if (existing.state === 'ended') return this.toRecord(existing);
    const ended = this.store.end(id, reason, this.now());
    this.clearExpiry(id);
    void this.stopRecorder(id);
    const event: ShareEndedEvent = { shareId: id, reason };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('[share] onEnded listener failed:', error);
      }
    }
    return ended ? this.toRecord(ended) : null;
  }

  readLog(id: string, options: { after?: number; limit?: number } = {}): ShareLogPage | null {
    if (!this.store.get(id)) return null;
    this.recorders.get(id)?.flush();
    return this.store.readLog(id, options);
  }

  getSettings(): ShareSettings {
    return this.store.getSettings();
  }

  updateSettings(patch: Partial<ShareSettings>): ShareSettings {
    const current = this.store.getSettings();
    const next: ShareSettings = {
      recordLogs: patch.recordLogs ?? current.recordLogs,
      logRetentionDays: clampInt(
        patch.logRetentionDays ?? current.logRetentionDays,
        0,
        3650,
        SHARE_DEFAULT_SETTINGS.logRetentionDays
      ),
      logMaxBytes: clampInt(
        patch.logMaxBytes ?? current.logMaxBytes,
        1024,
        4 * 1024 * 1024 * 1024,
        SHARE_DEFAULT_SETTINGS.logMaxBytes
      ),
      defaultOrigin:
        patch.defaultOrigin === undefined
          ? current.defaultOrigin
          : normalizeDefaultOrigin(patch.defaultOrigin),
    };
    return this.store.saveSettings(next, this.now());
  }

  listOrigins(): ShareOriginsView {
    const settings = this.store.getSettings();
    const context = this.originContext();
    const recommended = settings.defaultOrigin ?? context.candidates[0]?.url ?? null;
    return {
      candidates: context.candidates,
      recommended,
      nodePrefix: recommended ? resolveSharePrefix(context, recommended) : context.nodePrefix,
    };
  }

  verifyAccessToken(token: string, now = this.now()): VerifiedShareAccess | null {
    const parsed = parseShareToken(token);
    if (!parsed) return null;
    const raw = `${parsed.shareId}.${parsed.secret}`;
    const access = this.store.findAccessToken(hashShareToken(raw));
    if (!access || access.shareId !== parsed.shareId) return null;
    const share = this.store.get(access.shareId);
    if (!share || share.state !== 'active') return null;
    if (share.expiresAt !== null && share.expiresAt <= now) {
      this.endShare(share.id, 'expired');
      return null;
    }
    if (access.expiresAt <= now) {
      this.store.deleteAccessToken(hashShareToken(raw));
      return null;
    }
    const expiresAt = this.renewAccess(access.id, access.expiresAt, share.expiresAt, now);
    return {
      scope: { shareId: share.id, deviceId: share.deviceId, windowId: share.windowId },
      accessId: access.id,
      expiresAt,
    };
  }

  private renewAccess(
    accessId: string,
    current: number,
    shareExpiresAt: number | null,
    now: number
  ): number {
    if (current - now > SHARE_ACCESS_TTL_MS / 2) return current;
    const target = accessExpiry(shareExpiresAt, now);
    if (target <= current) return current;
    this.store.renewAccessToken(accessId, target, now);
    return target;
  }

  async loginAccess(
    shareId: string,
    password: string,
    clientIp: string
  ): Promise<ShareLoginResult> {
    const share = this.store.get(shareId);
    if (!share) return { ok: false, code: 'SHARE_NOT_FOUND' };
    const now = this.now();
    if (share.state !== 'active') return { ok: false, code: 'SHARE_ENDED' };
    if (share.expiresAt !== null && share.expiresAt <= now) {
      this.endShare(shareId, 'expired');
      return { ok: false, code: 'SHARE_ENDED' };
    }
    const lockedFor = this.limiter.lockedFor(shareId, clientIp);
    if (lockedFor > 0) {
      return { ok: false, code: 'SHARE_LOGIN_LOCKED', retryAfterMs: lockedFor };
    }
    const stored = this.store.passwordHash(shareId);
    const verify = this.deps.verifyPassword ?? verifySharePassword;
    const valid = stored ? await verify(stored, password ?? '') : false;
    if (!valid) {
      this.limiter.recordFailure(shareId, clientIp);
      const retryAfterMs = this.limiter.lockedFor(shareId, clientIp);
      return retryAfterMs > 0
        ? { ok: false, code: 'SHARE_LOGIN_LOCKED', retryAfterMs }
        : { ok: false, code: 'SHARE_PASSWORD_INVALID' };
    }
    this.limiter.reset(shareId, clientIp);
    const token = generateShareToken(shareId);
    const expiresAt = accessExpiry(share.expiresAt, now);
    this.store.createAccessToken({
      id: hashShareToken(token).slice(0, 32),
      shareId,
      tokenHash: hashShareToken(token),
      clientIp: clientIp || null,
      createdAt: now,
      expiresAt,
    });
    return {
      ok: true,
      token,
      expiresAt,
      maxAgeSec: Math.max(1, Math.ceil((expiresAt - now) / 1000)),
    };
  }

  logoutAccess(token: string): void {
    const parsed = parseShareToken(token);
    if (!parsed) return;
    this.store.deleteAccessToken(hashShareToken(`${parsed.shareId}.${parsed.secret}`));
  }

  onEnded(listener: (event: ShareEndedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  recordInput(scope: ShareScope, paneId: string, bytes: Uint8Array): void {
    this.recorders.get(scope.shareId)?.recordInput(paneId, bytes);
  }

  recordResize(scope: ShareScope, paneId: string, cols: number, rows: number): void {
    this.recorders.get(scope.shareId)?.recordResize(paneId, cols, rows);
  }

  setViewerCounter(fn: ShareViewerCounter | null): void {
    this.viewerCounter = fn;
  }

  startSweeper(): void {
    if (this.running) return;
    this.running = true;
    this.store.sweepAccessTokens(this.now());
    for (const row of this.store.listActive()) {
      if (this.expireIfDue(row)) continue;
      this.scheduleExpiry(row);
      void this.startRecorder(row);
    }
    this.watchTimer = setInterval(
      () => this.watchTick(),
      this.deps.watchIntervalMs ?? SHARE_WATCH_INTERVAL_MS
    );
    this.retentionTimer = setInterval(
      () => this.retentionTick(),
      this.deps.retentionSweepMs ?? SHARE_RETENTION_SWEEP_MS
    );
    this.retentionTick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.watchTimer) clearInterval(this.watchTimer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.watchTimer = null;
    this.retentionTimer = null;
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    const recorders = [...this.recorders.values()];
    this.recorders.clear();
    await Promise.all(recorders.map((recorder) => recorder.stop()));
  }

  watchTick(): void {
    for (const row of this.store.listActive()) {
      if (this.expireIfDue(row)) continue;
      if (!this.deviceExists(row.deviceId)) {
        this.endShare(row.id, 'device_removed');
        continue;
      }
      const snapshot = this.snapshotOf(row.deviceId);
      if (snapshot && !hasWindow(snapshot, row.windowId)) {
        this.endShare(row.id, 'window_closed');
        continue;
      }
      if (!this.recorders.has(row.id)) void this.startRecorder(row);
    }
  }

  retentionTick(): void {
    const now = this.now();
    this.store.sweepAccessTokens(now);
    const { logRetentionDays } = this.store.getSettings();
    if (logRetentionDays <= 0) return;
    this.store.purgeLogsBefore(now - logRetentionDays * 86_400_000, now);
  }

  private expireIfDue(row: ShareRow): boolean {
    if (row.expiresAt === null || row.expiresAt > this.now()) return false;
    this.endShare(row.id, 'expired');
    return true;
  }

  private scheduleExpiry(row: ShareRow): void {
    this.clearExpiry(row.id);
    if (row.expiresAt === null) return;
    const delay = Math.min(MAX_TIMEOUT_MS, Math.max(0, row.expiresAt - this.now()));
    const timer = setTimeout(() => {
      this.expiryTimers.delete(row.id);
      const current = this.store.get(row.id);
      if (!current || current.state !== 'active') return;
      if (!this.expireIfDue(current)) this.scheduleExpiry(current);
    }, delay);
    timer.unref?.();
    this.expiryTimers.set(row.id, timer);
  }

  private clearExpiry(id: string): void {
    const timer = this.expiryTimers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.expiryTimers.delete(id);
  }

  private async startRecorder(row: ShareRow): Promise<void> {
    if (!row.recordLog || row.logTruncated || this.recorders.has(row.id)) return;
    if (this.deps.autoStartRecorders === false) return;
    const acquire = this.deps.acquireRuntime ?? defaultAcquireRuntime;
    const release = this.deps.releaseRuntime ?? defaultReleaseRuntime;
    const recorder = new ShareRecorder(row.id, row.deviceId, row.windowId, {
      acquireRuntime: acquire,
      releaseRuntime: release,
      appendLog: (shareId, entries) => this.appendLog(shareId, entries),
      now: this.now,
      ...(this.deps.recorderFlushIntervalMs === undefined
        ? {}
        : { flushIntervalMs: this.deps.recorderFlushIntervalMs }),
      ...(this.deps.recorderPollIntervalMs === undefined
        ? {}
        : { pollIntervalMs: this.deps.recorderPollIntervalMs }),
      onError: (shareId, error) => {
        console.error(`[share] recorder ${shareId} failed:`, error);
      },
    });
    this.recorders.set(row.id, recorder);
    try {
      await recorder.start();
    } catch (error) {
      console.error(`[share] recorder ${row.id} failed to start:`, error);
      this.recorders.delete(row.id);
      await recorder.stop();
    }
  }

  private async stopRecorder(id: string): Promise<void> {
    const recorder = this.recorders.get(id);
    if (!recorder) return;
    this.recorders.delete(id);
    await recorder.stop();
  }

  private appendLog(
    shareId: string,
    entries: readonly ShareLogAppend[]
  ): { truncated: boolean } | null {
    const share = this.store.get(shareId);
    if (!share || share.state !== 'active' || !share.recordLog) return null;
    const result = this.store.appendLogEntries(
      shareId,
      entries,
      this.store.getSettings().logMaxBytes
    );
    return result ? { truncated: result.truncated } : null;
  }
}

export function createShareService(deps: ShareServiceDeps = {}): ShareService {
  return new ShareServiceImpl(deps);
}

let instance: ShareService | null = null;

export function getShareService(): ShareService {
  if (!instance) instance = createShareService();
  return instance;
}

export function setShareServiceForTests(service: ShareService | null): void {
  instance = service;
}
