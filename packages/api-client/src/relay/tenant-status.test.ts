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
