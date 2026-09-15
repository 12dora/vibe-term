// `vibeterm settings memory get|set`：读写本机窗口内存限额。

import {
  WINDOW_MEMORY_INTERVAL_MAX_SEC,
  WINDOW_MEMORY_INTERVAL_MIN_SEC,
  WINDOW_MEMORY_MB_MAX,
  type WindowMemorySettings,
} from '@vibeterm/shared';
import { type FlagValues, flagNumber, flagString } from '../core/args';
import { type SubHandler, emit, parseOnOff, rejectExtra, requireArg } from '../core/cmd';
import type { CliContext } from '../core/context';
import { UsageError } from '../core/errors';
import { jsonSelf } from './settings-http';

const RECORD_KEYS = [
  'enabled',
  'memoryHighMb',
  'memoryMaxMb',
  'memorySwapMaxMb',
  'sampleIntervalSec',
] as const;

function requireInt(value: number, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new UsageError(`${label} must be an integer ${min}..${max}`, `got ${value}`);
  }
  return value;
}

function optionalIntFlag(
  flags: FlagValues,
  key: string,
  min: number,
  max: number
): number | undefined {
  const value = flagNumber(flags, key);
  if (value === undefined) return undefined;
  return requireInt(value, `--${key}`, min, max);
}

function readInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new UsageError(`${label} must be an integer`, `got ${value}`);
  }
  return value;
}

function asSettings(raw: unknown): WindowMemorySettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UsageError('window-memory settings response is not an object');
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec.enabled !== 'boolean') {
    throw new UsageError('window-memory settings.enabled must be a boolean');
  }
  return {
    enabled: rec.enabled,
    memoryHighMb: readInt(rec.memoryHighMb, 'memoryHighMb'),
    memoryMaxMb: readInt(rec.memoryMaxMb, 'memoryMaxMb'),
    memorySwapMaxMb: readInt(rec.memorySwapMaxMb, 'memorySwapMaxMb'),
    sampleIntervalSec: readInt(rec.sampleIntervalSec, 'sampleIntervalSec'),
  };
}

function validateSettings(record: WindowMemorySettings): void {
  requireInt(record.memoryHighMb, 'memoryHighMb', 0, WINDOW_MEMORY_MB_MAX);
  requireInt(record.memoryMaxMb, 'memoryMaxMb', 0, WINDOW_MEMORY_MB_MAX);
  requireInt(record.memorySwapMaxMb, 'memorySwapMaxMb', 0, WINDOW_MEMORY_MB_MAX);
  requireInt(
    record.sampleIntervalSec,
    '--interval',
    WINDOW_MEMORY_INTERVAL_MIN_SEC,
    WINDOW_MEMORY_INTERVAL_MAX_SEC
  );
  if (
    record.memoryHighMb !== 0 &&
    record.memoryMaxMb !== 0 &&
    record.memoryHighMb > record.memoryMaxMb
  ) {
    throw new UsageError(
      'memoryHighMb must be ≤ memoryMaxMb when both are non-zero',
      `high=${record.memoryHighMb} max=${record.memoryMaxMb}`
    );
  }
}

function overlayFromFlags(flags: FlagValues): Partial<WindowMemorySettings> {
  const overlay: Partial<WindowMemorySettings> = {};
  const enabled = flagString(flags, 'enabled');
  if (enabled !== undefined) overlay.enabled = parseOnOff(enabled);
  const high = optionalIntFlag(flags, 'high', 0, WINDOW_MEMORY_MB_MAX);
  if (high !== undefined) overlay.memoryHighMb = high;
  const max = optionalIntFlag(flags, 'max', 0, WINDOW_MEMORY_MB_MAX);
  if (max !== undefined) overlay.memoryMaxMb = max;
  const swapMax = optionalIntFlag(flags, 'swap-max', 0, WINDOW_MEMORY_MB_MAX);
  if (swapMax !== undefined) overlay.memorySwapMaxMb = swapMax;
  const interval = optionalIntFlag(
    flags,
    'interval',
    WINDOW_MEMORY_INTERVAL_MIN_SEC,
    WINDOW_MEMORY_INTERVAL_MAX_SEC
  );
  if (interval !== undefined) overlay.sampleIntervalSec = interval;
  return overlay;
}

function printRecord(ctx: CliContext, payload: unknown): void {
  emit(ctx, payload, () => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      ctx.out.data(payload);
      return;
    }
    const rec = payload as Record<string, unknown>;
    const keys = [
      ...RECORD_KEYS.filter((key) => key in rec),
      ...Object.keys(rec).filter((key) => !(RECORD_KEYS as readonly string[]).includes(key)),
    ];
    const width = Math.max(...keys.map((key) => key.length));
    for (const key of keys) {
      ctx.out.line(`${key.padEnd(width)}  ${String(rec[key])}`);
    }
  });
}

export const memory: SubHandler = async (ctx, flags, positionals) => {
  const action = requireArg(positionals, 0, 'get|set');
  if (action === 'get') {
    rejectExtra(positionals, 1);
    printRecord(ctx, await jsonSelf(ctx, 'GET', '/api/settings/window-memory'));
    return;
  }
  if (action === 'set') {
    rejectExtra(positionals, 1);
    const overlay = overlayFromFlags(flags);
    const current = asSettings(await jsonSelf(ctx, 'GET', '/api/settings/window-memory'));
    const next = { ...current, ...overlay };
    validateSettings(next);
    printRecord(ctx, await jsonSelf(ctx, 'PUT', '/api/settings/window-memory', next));
    return;
  }
  throw new UsageError(`unknown memory action: ${action}`, 'use get|set');
};
