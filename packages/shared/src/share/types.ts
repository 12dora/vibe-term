export type ShareState = 'active' | 'ended';

export type ShareEndReason = 'revoked' | 'expired' | 'window_closed' | 'device_removed';

export interface ShareScope {
  shareId: string;
  deviceId: string;
  windowId: string;
}

export interface ShareRecord {
  id: string;
  name: string;
  deviceId: string;
  windowId: string;
  windowName: string;
  state: ShareState;
  endReason: ShareEndReason | null;
  createdAt: number;
  expiresAt: number | null;
  endedAt: number | null;
  origin: string;
  url: string;
  viewers: number;
  logBytes: number;
  logTruncated: boolean;
  recordLog: boolean;
}

export interface ShareSettings {
  recordLogs: boolean;
  logRetentionDays: number;
  logMaxBytes: number;
  defaultOrigin: string | null;
}

export type ShareOriginKind = 'custom' | 'site' | 'hub' | 'relay' | 'tunnel' | 'ip';

export interface ShareOriginCandidate {
  url: string;
  kind: ShareOriginKind;
  label: string;
}

export type ShareLogKind = 'out' | 'in' | 'resize' | 'checkpoint';

export interface ShareLogEntry {
  seq: number;
  at: number;
  kind: ShareLogKind;
  paneId: string;
  data: string;
  cols?: number;
  rows?: number;
}

export interface ShareLogPage {
  entries: ShareLogEntry[];
  nextAfter: number | null;
  total: number;
  truncated: boolean;
}

export const SHARE_PASSWORD_MIN_LENGTH = 6;

export const SHARE_DURATION_PRESETS_MS = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
} as const;

export const SHARE_DEFAULT_SETTINGS: ShareSettings = {
  recordLogs: true,
  logRetentionDays: 30,
  logMaxBytes: 50 * 1024 * 1024,
  defaultOrigin: null,
};

export const SHARE_ID_LENGTH = 22;

/** 分享连接关闭码：终止 / 到期 / 窗口关闭。 */
export const SHARE_WS_CLOSE_ENDED = 4410;
/** 分享连接关闭码：凭证无效或缺失。 */
export const SHARE_WS_CLOSE_LOGIN_REQUIRED = 4401;

export const SHARE_LOG_PAGE_MAX_ENTRIES = 2000;
export const SHARE_LOG_PAGE_MAX_BYTES = 2 * 1024 * 1024;
