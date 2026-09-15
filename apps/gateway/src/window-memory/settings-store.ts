import {
  WINDOW_MEMORY_INTERVAL_MAX_SEC,
  WINDOW_MEMORY_INTERVAL_MIN_SEC,
  WINDOW_MEMORY_MB_MAX,
  WINDOW_MEMORY_SETTINGS_DEFAULTS,
  type WindowMemorySettings,
} from '@vibeterm/shared';
import { getGatewayKv, setGatewayKv } from '../db/kv';

export const WINDOW_MEMORY_SETTINGS_KV_KEY = 'windowMemory.settings';
export const INVALID_WINDOW_MEMORY_SETTINGS = 'INVALID_WINDOW_MEMORY_SETTINGS';

export type WindowMemorySettingsKv = {
  get(key: string): string | null;
  set(key: string, value: string): void;
};

export class InvalidWindowMemorySettingsError extends Error {
  readonly code = INVALID_WINDOW_MEMORY_SETTINGS;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidWindowMemorySettingsError';
  }
}

export type WindowMemorySettingsStore = {
  get(): WindowMemorySettings;
  set(next: unknown): WindowMemorySettings;
  subscribe(fn: (settings: WindowMemorySettings) => void): () => void;
};

const FIELDS = [
  'enabled',
  'memoryHighMb',
  'memoryMaxMb',
  'memorySwapMaxMb',
  'sampleIntervalSec',
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireBoolean(name: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new InvalidWindowMemorySettingsError(`${name} must be a boolean`);
  }
  return value;
}

function requireInt(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new InvalidWindowMemorySettingsError(
      `${name} must be an integer between ${min} and ${max}`
    );
  }
  return value;
}

export function parseWindowMemorySettings(input: unknown): WindowMemorySettings {
  if (!isPlainObject(input)) {
    throw new InvalidWindowMemorySettingsError('body must be an object');
  }
  for (const field of FIELDS) {
    if (!(field in input)) {
      throw new InvalidWindowMemorySettingsError(`missing ${field}`);
    }
  }
  const enabled = requireBoolean('enabled', input.enabled);
  const memoryHighMb = requireInt('memoryHighMb', input.memoryHighMb, 0, WINDOW_MEMORY_MB_MAX);
  const memoryMaxMb = requireInt('memoryMaxMb', input.memoryMaxMb, 0, WINDOW_MEMORY_MB_MAX);
  const memorySwapMaxMb = requireInt(
    'memorySwapMaxMb',
    input.memorySwapMaxMb,
    0,
    WINDOW_MEMORY_MB_MAX
  );
  const sampleIntervalSec = requireInt(
    'sampleIntervalSec',
    input.sampleIntervalSec,
    WINDOW_MEMORY_INTERVAL_MIN_SEC,
    WINDOW_MEMORY_INTERVAL_MAX_SEC
  );
  if (memoryHighMb !== 0 && memoryMaxMb !== 0 && memoryHighMb > memoryMaxMb) {
    throw new InvalidWindowMemorySettingsError(
      'memoryHighMb must be <= memoryMaxMb when both are non-zero'
    );
  }
  return { enabled, memoryHighMb, memoryMaxMb, memorySwapMaxMb, sampleIntervalSec };
}

function settingsEqual(a: WindowMemorySettings, b: WindowMemorySettings): boolean {
  return (
    a.enabled === b.enabled &&
    a.memoryHighMb === b.memoryHighMb &&
    a.memoryMaxMb === b.memoryMaxMb &&
    a.memorySwapMaxMb === b.memorySwapMaxMb &&
    a.sampleIntervalSec === b.sampleIntervalSec
  );
}

function mergeOverDefaults(raw: unknown): unknown {
  if (!isPlainObject(raw)) return { ...WINDOW_MEMORY_SETTINGS_DEFAULTS };
  return { ...WINDOW_MEMORY_SETTINGS_DEFAULTS, ...raw };
}

export function createWindowMemorySettingsStore(
  kv: WindowMemorySettingsKv
): WindowMemorySettingsStore {
  const listeners = new Set<(settings: WindowMemorySettings) => void>();
  let cached: WindowMemorySettings | null = null;

  function read(): WindowMemorySettings {
    if (cached !== null) return cached;
    let raw: string | null = null;
    try {
      raw = kv.get(WINDOW_MEMORY_SETTINGS_KV_KEY);
    } catch {
      raw = null;
    }
    if (raw === null) {
      cached = { ...WINDOW_MEMORY_SETTINGS_DEFAULTS };
      return cached;
    }
    try {
      cached = parseWindowMemorySettings(mergeOverDefaults(JSON.parse(raw)));
    } catch {
      cached = { ...WINDOW_MEMORY_SETTINGS_DEFAULTS };
    }
    return cached;
  }

  return {
    get: read,
    set(next) {
      const parsed = parseWindowMemorySettings(next);
      const prev = read();
      kv.set(WINDOW_MEMORY_SETTINGS_KV_KEY, JSON.stringify(parsed));
      cached = parsed;
      if (settingsEqual(parsed, prev)) return parsed;
      for (const fn of listeners) fn(parsed);
      return parsed;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

let singleton: WindowMemorySettingsStore | null = null;

export function getWindowMemorySettingsStore(): WindowMemorySettingsStore {
  singleton ??= createWindowMemorySettingsStore({
    get: getGatewayKv,
    set: setGatewayKv,
  });
  return singleton;
}

export function resetWindowMemorySettingsStoreForTests(): void {
  singleton = null;
}
