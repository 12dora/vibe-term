// 登录历史（每节点本地表）的 HTTP 契约。网关、前端和 CLI 共用。

export const LOGIN_RECORD_CLIENT_HEADER = 'x-vibeterm-client';
export const LOGIN_RECORD_ENTRY_CLIENT_IP_HEADER = 'x-vibeterm-entry-client-ip';

export const LOGIN_RECORD_RETENTION_CHOICES = [7, 30, 90, 180, 0] as const;
export type LoginRecordRetentionDays = (typeof LOGIN_RECORD_RETENTION_CHOICES)[number];
export const LOGIN_RECORD_RETENTION_DEFAULT: LoginRecordRetentionDays = 90;

export const LOGIN_RECORD_PAGE_DEFAULT_LIMIT = 200;
export const LOGIN_RECORD_PAGE_MAX_LIMIT = 500;

/** 低于该版本的节点没有登录历史接口。 */
export const MIN_LOGIN_RECORDS_VERSION = '2.10.0';

export type LoginRecordOutcome = 'success' | 'failed';
export type LoginRecordClient = 'web' | 'cli' | 'unknown';
export type LoginRecordKind = 'interactive' | 'background';
export type LoginRecordMethod = 'root' | 'passkey';
export type LoginRecordSecond = 'totp' | 'passkey' | 'waived' | 'none';

export interface LoginRecord {
  id: string;
  at: number;
  outcome: LoginRecordOutcome;
  uid: string | null;
  username: string | null;
  method: LoginRecordMethod | null;
  second: LoginRecordSecond | null;
  client: LoginRecordClient;
  kind: LoginRecordKind;
  viaNodeId: string | null;
  targetNodeId: string | null;
  ip: string | null;
  userAgent: string | null;
  origin: string | null;
  code: string | null;
}

/** 分页游标。同一毫秒的多行靠 `id` 区分，避免只按 `at` 翻页时被跳过。 */
export interface LoginRecordCursor {
  at: number;
  id: string;
}

export interface LoginRecordsPage {
  records: LoginRecord[];
  nextBefore: LoginRecordCursor | null;
}

export interface LoginRecordsQuery {
  outcome: LoginRecordOutcome;
  /** 只作用于成功列表；失败列表始终返回全部 kind。缺省 interactive。 */
  kind?: 'interactive' | 'all';
  limit?: number;
  /** 只返回排在该 `(at, id)` 之前的记录（`at` 降序，同一毫秒再按 `id` 降序）。 */
  before?: LoginRecordCursor;
}

export interface LoginRecordSettings {
  retentionDays: LoginRecordRetentionDays;
}

export interface LoginRecordsClearResult {
  deleted: number;
}

export function isLoginRecordRetentionDays(value: unknown): value is LoginRecordRetentionDays {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    (LOGIN_RECORD_RETENTION_CHOICES as readonly number[]).includes(value)
  );
}
