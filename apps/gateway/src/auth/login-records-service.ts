import {
  LOGIN_RECORD_RETENTION_DEFAULT,
  type LoginRecordSettings,
  type LoginRecordsPage,
  isLoginRecordRetentionDays,
} from '@vibeterm/shared';
import { warnLine } from '../mesh/mesh-log';
import {
  LoginRecordStore as DefaultLoginRecordStore,
  type LoginRecordListQuery,
  type LoginRecordStore,
  type NewLoginRecord,
} from './login-records-store';

export const LOGIN_RECORD_RETENTION_SWEEP_MS = 60 * 60 * 1000;

export class LoginRecordSettingsError extends Error {
  constructor() {
    super('invalid login record retention');
    this.name = 'LoginRecordSettingsError';
  }
}

type ServiceOpts = {
  now?: () => number;
  sweepMs?: number;
};

export class LoginRecordService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly sweepMs: number;

  constructor(
    private readonly store: LoginRecordStore,
    opts: ServiceOpts = {}
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.sweepMs = opts.sweepMs ?? LOGIN_RECORD_RETENTION_SWEEP_MS;
  }

  record(input: NewLoginRecord): void {
    try {
      this.store.insert({ ...input, at: input.at ?? this.now() });
    } catch (err) {
      warnLoginRecord(err);
    }
  }

  list(query: LoginRecordListQuery): LoginRecordsPage {
    return this.store.list(query);
  }

  clear(): number {
    return this.store.deleteAll();
  }

  getSettings(): LoginRecordSettings {
    const stored = this.store.getRetentionDays();
    const retentionDays = isLoginRecordRetentionDays(stored)
      ? stored
      : LOGIN_RECORD_RETENTION_DEFAULT;
    return { retentionDays };
  }

  updateSettings(body: unknown): LoginRecordSettings {
    if (!isSettingsBody(body)) throw new LoginRecordSettingsError();
    this.store.setRetentionDays(body.retentionDays);
    return { retentionDays: body.retentionDays };
  }

  startSweeper(): void {
    if (this.timer) return;
    this.retentionTick();
    const timer = setInterval(() => this.retentionTick(), this.sweepMs);
    timer.unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  retentionTick(): void {
    try {
      const { retentionDays } = this.getSettings();
      if (retentionDays <= 0) return;
      this.store.purgeBefore(this.now() - retentionDays * 86_400_000);
    } catch (err) {
      warnLoginRecord(err);
    }
  }
}

let singleton: LoginRecordService | null = null;

export function bindLoginRecordService(service: LoginRecordService | null): void {
  if (singleton && singleton !== service) singleton.stop();
  singleton = service;
}

export function peekLoginRecordService(): LoginRecordService | null {
  return singleton;
}

export function getLoginRecordService(): LoginRecordService {
  if (!singleton) singleton = new LoginRecordService(new DefaultLoginRecordStore());
  return singleton;
}

export function warnLoginRecord(err: unknown): void {
  const message = err instanceof Error ? err.message : 'error';
  warnLine('[auth]', `login record write failed: ${message}`);
}

function isSettingsBody(body: unknown): body is LoginRecordSettings {
  if (typeof body !== 'object' || body === null) return false;
  return isLoginRecordRetentionDays((body as { retentionDays?: unknown }).retentionDays);
}
