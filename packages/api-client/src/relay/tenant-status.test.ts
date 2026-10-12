import { describe, expect, test } from 'bun:test';
import { normalizeRelayStatus } from './tenant-status';

describe('normalizeRelayStatus enrollPassword', () => {
  test('缺字段补 { known: false }，true 才算已知', () => {
    const missing = normalizeRelayStatus({
      relays: [{ url: 'https://a.example', priority: 0, online: true, attached: true }],
    }).relays[0];
    expect(missing?.enrollPassword).toEqual({ known: false });

    const known = normalizeRelayStatus({
      relays: [
        {
          url: 'https://a.example',
          priority: 0,
          online: true,
          attached: true,
          enrollPassword: { known: true },
        },
      ],
    }).relays[0];
    expect(known?.enrollPassword).toEqual({ known: true });
  });

  test('known 不是布尔 true 时一律 false', () => {
    const row = normalizeRelayStatus({
      relays: [
        {
          url: 'https://a.example',
          priority: 0,
          online: true,
          attached: true,
          enrollPassword: { known: 1 } as never,
        },
      ],
    }).relays[0];
    expect(row?.enrollPassword).toEqual({ known: false });
  });
});

describe('normalizeRelayStatus 逐行租户编号', () => {
  test('每行保留自己的编号，旧网关不下发时保持缺席', () => {
    const status = normalizeRelayStatus({
      tenantId: 'bb'.repeat(16),
      relays: [
        {
          url: 'https://sh.example',
          tenantId: 'aa'.repeat(16),
          priority: 0,
          online: true,
          attached: true,
        },
        {
          url: 'https://jp.example',
          tenantId: 'bb'.repeat(16),
          priority: 1,
          online: true,
          attached: true,
        },
        { url: 'https://old.example', priority: 2, online: false, attached: false },
      ],
    });
    expect(status.relays.map((row) => row.tenantId)).toEqual([
      'aa'.repeat(16),
      'bb'.repeat(16),
      undefined,
    ]);
    expect('tenantId' in (status.relays[2] ?? {})).toBe(false);
    expect(status.tenantId).toBe('bb'.repeat(16));
  });
});
