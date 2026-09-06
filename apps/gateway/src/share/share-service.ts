import type { StateSnapshotPayload } from '@vibeterm/shared';
import {
  SHARE_DEFAULT_SETTINGS,
  SHARE_PASSWORD_MIN_LENGTH,
  type ShareEndReason,
  type ShareLogPage,
  type ShareRecord,
  type ShareScope,
  type ShareSettings,
  buildShareUrl,
  normalizeShareOrigin,
} from '@vibeterm/shared/share';
import { getDeviceById } from '../db';
import { tmuxRuntimeRegistry } from '../tmux-client/registry';
import { getDeviceSnapshot } from '../tmux/snapshot-directory';
import { ShareAccessManager } from './share-access-tokens';
import {
  type ShareOriginContext,
  type ShareOriginSources,
  buildShareOriginContext,
  defaultShareOriginSources,
  resolveSharePrefix,
} from './share-origins';
import { SharePasswordManager } from './share-password-service';
import { ShareRecorder, type ShareRecorderRuntime, hasWindow } from './share-recorder';
import {
  clampInt,
  defaultAcquireRuntime,
  defaultReleaseRuntime,
  normalizeDefaultOrigin,
} from './share-service-support';
import { type ShareLogAppend, type ShareRow, ShareStore } from './share-store';
import { generateShareId } from './share-token';
import type {
  ShareCreateInput,
  ShareCreateResult,
  ShareEndedEvent,
  ShareListFilter,
  ShareListResult,
  ShareLoginResult,
  ShareOriginsView,
  SharePasswordResult,
  ShareService,
  ShareServiceDeps,
  ShareSessionsRevokedEvent,
  ShareSetPasswordResult,
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
  private readonly access: ShareAccessManager;
  private readonly passwords: SharePasswordManager;
  private readonly listeners = new Set<(event: ShareEndedEvent) => void>();
  private readonly revokeListeners = new Set<(event: ShareSessionsRevokedEvent) => void>();
  private readonly recorders = new Map<string, ShareRecorder>();
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private viewerCounter: ShareViewerCounter | null = null;
  private authRequired: () => boolean = () => true;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private retentionTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly deps: ShareServiceDeps = {}) {
    this.store = deps.store ?? new ShareStore();
    this.now = deps.now ?? Date.now;
    this.access = new ShareAccessManager(this.store, deps, this.now, (shareId) =>
      this.endShare(shareId, 'expired')
    );
    this.passwords = new SharePasswordManager(this.store, deps);
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
    if (!this.isAuthRequired()) return { ok: false, code: 'SHARE_AUTH_REQUIRED' };
    const password = input.password ?? '';
    if (password.length < SHARE_PASSWORD_MIN_LENGTH) {
      return { ok: false, code: 'SHARE_PASSWORD_TOO_SHORT' };
    }
    const snapshot = this.snapshotOf(input.deviceId);
    const window = snapshot?.session?.windows.find((item) => item.id === input.windowId);
    if (!window) return { ok: false, code: 'SHARE_WINDOW_NOT_FOUND' };

    const context = this.originContext();
    const origin = input.origin
      ? normalizeShareOrigin(input.origin)
      : (context.candidates[0]?.url ?? null);
    if (!origin) return { ok: false, code: 'SHARE_ORIGIN_INVALID' };

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
    const [hash, enc] = await Promise.all([
      this.passwords.hash(password),
      this.passwords.encrypt(password),
    ]);
    this.store.insert({ ...row, passwordHash: hash, passwordEnc: enc });
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

  getPassword(id: string): Promise<SharePasswordResult> {
    return this.passwords.read(id);
  }

  async setPassword(
    id: string,
    password: string,
    options: { endSessions?: boolean } = {}
  ): Promise<ShareSetPasswordResult> {
    const result = await this.passwords.write(id, password, {
      endSessions: options.endSessions === true,
      onRevoked: (shareId) => this.emitSessionsRevoked(shareId),
    });
    if (!result.ok) return result;
    return { ok: true, share: this.toRecord(result.row), endedSessions: result.endedSessions };
  }

  private emitSessionsRevoked(shareId: string): void {
    const event: ShareSessionsRevokedEvent = { shareId };
    for (const listener of this.revokeListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('[share] onSessionsRevoked listener failed:', error);
      }
    }
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
    // 先同步刷出缓冲：改成 ended 之后 appendLog 的 active 检查会丢掉最后一批录屏数据。
    this.recorders.get(id)?.flush();
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
    return this.access.verify(token, now);
  }

  loginAccess(shareId: string, password: string, clientIp: string): Promise<ShareLoginResult> {
    return this.access.login(shareId, password, clientIp);
  }

  logoutAccess(token: string): void {
    this.access.logout(token);
  }

  onEnded(listener: (event: ShareEndedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onSessionsRevoked(listener: (event: ShareSessionsRevokedEvent) => void): () => void {
    this.revokeListeners.add(listener);
    return () => {
      this.revokeListeners.delete(listener);
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

  /** 未开启登录的开放部署无法兑现分享隔离，因此禁止创建分享（由装配层注入判定）。 */
  setAuthRequiredResolver(fn: (() => boolean) | null): void {
    this.authRequired = fn ?? (() => true);
  }

  private isAuthRequired(): boolean {
    try {
      return this.authRequired();
    } catch {
      return true;
    }
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
