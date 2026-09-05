import type { StateSnapshotPayload } from '@tmex/shared';
import type {
  ShareEndReason,
  ShareLogPage,
  ShareOriginCandidate,
  ShareRecord,
  ShareScope,
  ShareSettings,
} from '@tmex/shared/share';
import type { ShareOriginSources } from './share-origins';
import type { ShareRecorderRuntime } from './share-recorder';
import type { ShareStore } from './share-store';

export type ShareErrorCode =
  | 'SHARE_NOT_FOUND'
  | 'SHARE_WINDOW_NOT_FOUND'
  | 'SHARE_PASSWORD_TOO_SHORT'
  | 'SHARE_ORIGIN_INVALID'
  | 'SHARE_AUTH_REQUIRED'
  | 'SHARE_ENDED';

export type ShareLoginErrorCode =
  | 'SHARE_NOT_FOUND'
  | 'SHARE_ENDED'
  | 'SHARE_PASSWORD_INVALID'
  | 'SHARE_LOGIN_LOCKED';

export type ShareCreateInput = {
  deviceId: string;
  windowId: string;
  name?: string | null;
  password: string;
  expiresInMs: number | null;
  origin?: string | null;
};

export type ShareCreateResult =
  | { ok: true; share: ShareRecord; password: string }
  | { ok: false; code: ShareErrorCode };

export type ShareLoginResult =
  | { ok: true; token: string; expiresAt: number; maxAgeSec: number }
  | { ok: false; code: ShareLoginErrorCode; retryAfterMs?: number };

export type VerifiedShareAccess = {
  scope: ShareScope;
  accessId: string;
  expiresAt: number;
  /** 本次验证顺带续期了访问凭证：调用方需要重新下发 cookie。 */
  renewed?: boolean;
  maxAgeSec?: number;
};

export type ShareEndedEvent = { shareId: string; reason: ShareEndReason };

export type ShareListFilter = { deviceId?: string; windowId?: string };

export type ShareListResult = { active: ShareRecord[]; history: ShareRecord[] };

export type ShareOriginsView = {
  candidates: ShareOriginCandidate[];
  recommended: string | null;
  nodePrefix: string | null;
};

export type ShareViewerCounter = (shareId: string) => number;

export interface ShareService {
  create(input: ShareCreateInput): Promise<ShareCreateResult>;
  list(filter?: ShareListFilter): ShareListResult;
  get(id: string): ShareRecord | null;
  revoke(id: string): ShareRecord | null;
  remove(id: string): boolean;
  endShare(id: string, reason: ShareEndReason): ShareRecord | null;
  readLog(id: string, options?: { after?: number; limit?: number }): ShareLogPage | null;
  getSettings(): ShareSettings;
  updateSettings(patch: Partial<ShareSettings>): ShareSettings;
  listOrigins(): ShareOriginsView;
  verifyAccessToken(token: string, now?: number): VerifiedShareAccess | null;
  loginAccess(shareId: string, password: string, clientIp: string): Promise<ShareLoginResult>;
  logoutAccess(token: string): void;
  onEnded(listener: (event: ShareEndedEvent) => void): () => void;
  recordInput(scope: ShareScope, paneId: string, bytes: Uint8Array): void;
  recordResize(scope: ShareScope, paneId: string, cols: number, rows: number): void;
  setViewerCounter(fn: ShareViewerCounter | null): void;
  /** 返回 false 表示本节点未开启登录：此时禁止创建分享。 */
  setAuthRequiredResolver(fn: (() => boolean) | null): void;
  startSweeper(): void;
  /** 巡检一次：到期 / 窗口关闭 / 设备删除；`startSweeper` 按周期调用，测试可直接触发。 */
  watchTick(): void;
  retentionTick(): void;
  stop(): Promise<void>;
}

export type ShareServiceDeps = {
  store?: ShareStore;
  now?: () => number;
  originSources?: ShareOriginSources;
  deviceExists?: (deviceId: string) => boolean;
  snapshotOf?: (deviceId: string) => StateSnapshotPayload | null;
  acquireRuntime?: (deviceId: string) => Promise<ShareRecorderRuntime>;
  releaseRuntime?: (deviceId: string, runtime: ShareRecorderRuntime) => Promise<void>;
  hashPassword?: (password: string) => Promise<string>;
  verifyPassword?: (stored: string, password: string) => Promise<boolean>;
  recorderFlushIntervalMs?: number;
  recorderPollIntervalMs?: number;
  watchIntervalMs?: number;
  retentionSweepMs?: number;
  autoStartRecorders?: boolean;
};
