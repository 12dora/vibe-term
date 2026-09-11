import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_STUN_SERVERS,
  LEGACY_DEFAULT_STUN_LISTS,
  isLegacyDefaultStunList,
  parseStunServersEnv,
  resolveEffectiveStun,
} from './stun-defaults';

describe('BUILTIN_STUN_SERVERS', () => {
  test('pins the four built-in entries and their order', () => {
    expect([...BUILTIN_STUN_SERVERS]).toEqual([
      'stun:stun.miwifi.com:3478',
      'stun:stun.chat.bilibili.com:3478',
      'stun:stun.l.google.com:19302',
      'stun:stun.cloudflare.com:3478',
    ]);
  });
});

describe('parseStunServersEnv', () => {
  test('unset or blank uses the builtin list', () => {
    expect(parseStunServersEnv(undefined)).toEqual({
      servers: [...BUILTIN_STUN_SERVERS],
      source: 'builtin',
    });
    expect(parseStunServersEnv('')).toEqual({
      servers: [...BUILTIN_STUN_SERVERS],
      source: 'builtin',
    });
    expect(parseStunServersEnv('  \t  ')).toEqual({
      servers: [...BUILTIN_STUN_SERVERS],
      source: 'builtin',
    });
  });

  test('none/off (case-insensitive) disables STUN', () => {
    for (const raw of ['none', 'NONE', ' off ', 'Off']) {
      expect(parseStunServersEnv(raw)).toEqual({ servers: [], source: 'disabled' });
    }
  });

  test('splits, trims, drops empties, and dedupes as custom', () => {
    expect(parseStunServersEnv('stun:a, stun:b,,stun:a, stun:c')).toEqual({
      servers: ['stun:a', 'stun:b', 'stun:c'],
      source: 'custom',
    });
  });

  test('a legacy default string is still custom at parse time', () => {
    for (const legacy of LEGACY_DEFAULT_STUN_LISTS) {
      expect(parseStunServersEnv(legacy)).toEqual({
        servers: legacy.split(',').map((item) => item.trim()),
        source: 'custom',
      });
    }
  });
});

describe('isLegacyDefaultStunList', () => {
  test('recognises the three historical defaults after trim/order-preserving split', () => {
    expect(isLegacyDefaultStunList('stun:stun.l.google.com:19302')).toBe(true);
    expect(
      isLegacyDefaultStunList(' stun:stun.l.google.com:19302 , stun:stun.cloudflare.com:3478 ')
    ).toBe(true);
    expect(isLegacyDefaultStunList(BUILTIN_STUN_SERVERS.join(','))).toBe(true);
    expect(isLegacyDefaultStunList(` ${BUILTIN_STUN_SERVERS.join(' , ')} `)).toBe(true);
    expect(LEGACY_DEFAULT_STUN_LISTS[2]).toBe(
      'stun:stun.miwifi.com:3478,stun:stun.chat.bilibili.com:3478,stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478'
    );
  });

  test('rejects a customised order or extra server', () => {
    expect(
      isLegacyDefaultStunList('stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302')
    ).toBe(false);
    expect(isLegacyDefaultStunList('stun:stun.example:3478')).toBe(false);
    expect(isLegacyDefaultStunList('')).toBe(false);
  });
});

describe('resolveEffectiveStun', () => {
  const builtin = { servers: [...BUILTIN_STUN_SERVERS], source: 'builtin' as const };
  const custom = { servers: ['stun:node:3478'], source: 'custom' as const };
  const disabled = { servers: [], source: 'disabled' as const };
  const hub = ['stun:hub:3478'];

  test('node custom wins over hub list', () => {
    expect(resolveEffectiveStun({ local: custom, distributed: hub })).toEqual({
      stun: ['stun:node:3478'],
      source: 'node-custom',
    });
  });

  test('node disabled yields an empty list even if hub sent servers', () => {
    expect(resolveEffectiveStun({ local: disabled, distributed: hub })).toEqual({
      stun: [],
      source: 'node-disabled',
    });
  });

  test('non-empty distributed list is hub-custom when local is builtin', () => {
    expect(resolveEffectiveStun({ local: builtin, distributed: hub })).toEqual({
      stun: ['stun:hub:3478'],
      source: 'hub-custom',
    });
  });

  test('empty or missing distributed list falls back to builtin', () => {
    expect(resolveEffectiveStun({ local: builtin, distributed: [] })).toEqual({
      stun: [...BUILTIN_STUN_SERVERS],
      source: 'builtin',
    });
    expect(resolveEffectiveStun({ local: builtin, distributed: null })).toEqual({
      stun: [...BUILTIN_STUN_SERVERS],
      source: 'builtin',
    });
    expect(resolveEffectiveStun({ local: builtin, distributed: undefined })).toEqual({
      stun: [...BUILTIN_STUN_SERVERS],
      source: 'builtin',
    });
  });
});
