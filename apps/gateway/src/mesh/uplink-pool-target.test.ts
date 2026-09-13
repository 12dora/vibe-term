import { describe, expect, test } from 'bun:test';
import { primaryTargetOf } from './uplink-pool-target';

describe('primaryTargetOf', () => {
  test('attached 优先，其次正在拨，空闲为 null', () => {
    expect(primaryTargetOf('https://sh.example', 'https://tk.example', true)).toBe(
      'https://sh.example'
    );
    expect(primaryTargetOf(null, 'https://tk.example', true)).toBe('https://tk.example');
    expect(primaryTargetOf(undefined, null, true)).toBeNull();
    expect(primaryTargetOf(null, 'https://tk.example', false)).toBeNull();
  });
});
