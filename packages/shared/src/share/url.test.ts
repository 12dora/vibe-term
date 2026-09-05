import { describe, expect, test } from 'bun:test';
import { buildShareUrl, nodeSharePrefix, sharePath } from './url';

describe('share url', () => {
  test('sharePath', () => {
    expect(sharePath('abc')).toBe('/s/abc');
  });

  test('nodeSharePrefix', () => {
    expect(nodeSharePrefix('n1')).toBe('/n/n1');
  });

  test('buildShareUrl 无节点前缀', () => {
    expect(buildShareUrl('https://a.example.com', null, 'sid')).toBe('https://a.example.com/s/sid');
    expect(buildShareUrl('https://a.example.com/', null, 'sid')).toBe(
      'https://a.example.com/s/sid'
    );
  });

  test('buildShareUrl 带节点前缀，前缀自动补斜杠并去尾斜杠', () => {
    expect(buildShareUrl('https://hub.example.com', '/n/node1', 'sid')).toBe(
      'https://hub.example.com/n/node1/s/sid'
    );
    expect(buildShareUrl('https://hub.example.com/', 'n/node1/', 'sid')).toBe(
      'https://hub.example.com/n/node1/s/sid'
    );
    expect(buildShareUrl('https://hub.example.com', '', 'sid')).toBe(
      'https://hub.example.com/s/sid'
    );
  });
});
