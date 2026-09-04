import { describe, expect, test } from 'bun:test';
import { createMigratedAuthDb } from '../auth/test-db';
import {
  orderRelaysByPreferred,
  readPreferredRelayUrl,
  writePreferredRelayUrl,
} from './relay-preferred';

describe('orderRelaysByPreferred', () => {
  const rows = [
    { url: 'https://a.example', priority: 0 },
    { url: 'https://b.example', priority: 1 },
    { url: 'https://c.example', priority: 2 },
  ];

  test('无首选或首选已是第一项时保持原序', () => {
    expect(orderRelaysByPreferred(rows, null)).toEqual(rows);
    expect(orderRelaysByPreferred(rows, 'https://a.example')).toEqual(rows);
    expect(orderRelaysByPreferred(rows, 'https://missing.example')).toEqual(rows);
  });

  test('把已配置的首选排到最前，其余相对顺序不变', () => {
    expect(orderRelaysByPreferred(rows, 'https://c.example')).toEqual([
      { url: 'https://c.example', priority: 2 },
      { url: 'https://a.example', priority: 0 },
      { url: 'https://b.example', priority: 1 },
    ]);
    expect(orderRelaysByPreferred(rows, 'https://b.example/')).toEqual([
      { url: 'https://b.example', priority: 1 },
      { url: 'https://a.example', priority: 0 },
      { url: 'https://c.example', priority: 2 },
    ]);
  });
});

describe('preferred relay kv', () => {
  test('读写首选中继地址', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      expect(readPreferredRelayUrl(db)).toBeNull();
      writePreferredRelayUrl(db, 'https://b.example');
      expect(readPreferredRelayUrl(db)).toBe('https://b.example');
      writePreferredRelayUrl(db, 'https://c.example');
      expect(readPreferredRelayUrl(db)).toBe('https://c.example');
    } finally {
      close();
    }
  });
});
