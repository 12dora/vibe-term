import { describe, expect, test } from 'bun:test';
import { pickRelayJoinTarget, preferRelayFirst } from './join-target';

const SH = { url: 'https://sh.example', tenantId: 'aa'.repeat(16), priority: 0 };
const JP = { url: 'https://jp.example', tenantId: 'bb'.repeat(16), priority: 1 };

describe('pickRelayJoinTarget', () => {
  test('no relays', () => {
    expect(pickRelayJoinTarget([], 'x')).toBeNull();
  });

  test('url and tenant come from the primary row, not the lowest priority', () => {
    const rows = [
      { ...SH, attached: true, role: 'secondary' as const },
      { ...JP, attached: true, role: 'primary' as const },
    ];
    expect(pickRelayJoinTarget(rows, SH.tenantId)).toEqual({
      url: JP.url,
      tenantId: JP.tenantId,
    });
  });

  test('attached row wins when no role is reported', () => {
    const rows = [
      { ...SH, attached: false },
      { ...JP, attached: true },
    ];
    expect(pickRelayJoinTarget(rows)).toEqual({ url: JP.url, tenantId: JP.tenantId });
  });

  test('nothing attached falls back to priority order regardless of input order', () => {
    expect(pickRelayJoinTarget([JP, SH])).toEqual({ url: SH.url, tenantId: SH.tenantId });
  });

  test('legacy gateway: top-level tenant belongs to the lowest-priority row', () => {
    const rows = [
      { url: SH.url, priority: 0, attached: true, role: 'secondary' as const },
      { url: JP.url, priority: 1, attached: true, role: 'primary' as const },
    ];
    expect(pickRelayJoinTarget(rows, SH.tenantId)).toEqual({
      url: SH.url,
      tenantId: SH.tenantId,
    });
  });

  test('legacy gateway without a tenant yet', () => {
    expect(pickRelayJoinTarget([{ url: SH.url }], null)).toEqual({ url: SH.url, tenantId: null });
  });

  test('legacy gateway: an empty per-row tenant counts as missing', () => {
    expect(pickRelayJoinTarget([{ url: SH.url, tenantId: '' }], 'legacy')).toEqual({
      url: SH.url,
      tenantId: 'legacy',
    });
    expect(pickRelayJoinTarget([{ url: SH.url, tenantId: '' }], '')).toEqual({
      url: SH.url,
      tenantId: null,
    });
  });

  test('nothing primary or attached: a kicked lowest-priority row is skipped', () => {
    const rows = [
      { ...SH, kicked: true },
      { ...JP, kicked: false, role: 'secondary' as const },
    ];
    expect(pickRelayJoinTarget(rows, SH.tenantId)).toEqual({ url: JP.url, tenantId: JP.tenantId });
  });

  test('primary or attached rows still win over the kicked filter', () => {
    const rows = [
      { ...SH, attached: true, kicked: true },
      { ...JP, kicked: false },
    ];
    expect(pickRelayJoinTarget(rows)).toEqual({ url: SH.url, tenantId: SH.tenantId });
  });

  test('every row kicked: lowest priority', () => {
    const rows = [
      { ...JP, kicked: true },
      { ...SH, kicked: true },
    ];
    expect(pickRelayJoinTarget(rows)).toEqual({ url: SH.url, tenantId: SH.tenantId });
  });

  test('legacy gateway: kicked state does not move the pairing off the lowest-priority row', () => {
    const rows = [
      { url: SH.url, priority: 0, kicked: true },
      { url: JP.url, priority: 1, kicked: false },
    ];
    expect(pickRelayJoinTarget(rows, SH.tenantId)).toEqual({
      url: SH.url,
      tenantId: SH.tenantId,
    });
  });
});

describe('preferRelayFirst', () => {
  const rows = [{ url: 'a' }, { url: 'b' }, { url: 'c' }];

  test('moves the preferred entry to the front and keeps the rest in order', () => {
    expect(preferRelayFirst(rows, 'c')).toEqual([{ url: 'c' }, { url: 'a' }, { url: 'b' }]);
  });

  test('unchanged when already first, unknown or empty', () => {
    expect(preferRelayFirst(rows, 'a')).toEqual(rows);
    expect(preferRelayFirst(rows, 'z')).toEqual(rows);
    expect(preferRelayFirst(rows, null)).toEqual(rows);
    expect(preferRelayFirst(rows)).toEqual(rows);
    expect(preferRelayFirst([], 'a')).toEqual([]);
  });

  test('does not mutate the input', () => {
    const input = [{ url: 'a' }, { url: 'b' }];
    preferRelayFirst(input, 'b');
    expect(input.map((row) => row.url)).toEqual(['a', 'b']);
  });
});
