import { describe, expect, test } from 'bun:test';
import { parseNodeIdFromPath, safeDecodePaneParam } from './pane-route';

const NODE_B = 'bb'.repeat(16);

describe('safeDecodePaneParam', () => {
  test('well-formed escape decodes once', () => {
    expect(safeDecodePaneParam('%252')).toBe('%2');
    expect(safeDecodePaneParam('%254')).toBe('%4');
    expect(safeDecodePaneParam('%401')).toBe('@1');
  });

  test('malformed percent sequences return the raw value instead of throwing', () => {
    expect(safeDecodePaneParam('%2')).toBe('%2');
    expect(safeDecodePaneParam('%zz')).toBe('%zz');
    expect(safeDecodePaneParam('%')).toBe('%');
    expect(safeDecodePaneParam('%E0%A4%A')).toBe('%E0%A4%A');
  });

  test('missing and empty params stay empty', () => {
    expect(safeDecodePaneParam(undefined)).toBeUndefined();
    expect(safeDecodePaneParam('')).toBeUndefined();
  });
});

describe('parseNodeIdFromPath', () => {
  test('reads a 32-hex /n/<id> prefix', () => {
    expect(parseNodeIdFromPath(`/n/${NODE_B}/devices/d1/windows/%401/panes/%252`)).toBe(NODE_B);
    expect(parseNodeIdFromPath(`/n/${NODE_B}`)).toBe(NODE_B);
  });

  test('paths without a valid node prefix are self', () => {
    expect(parseNodeIdFromPath('/devices/d1/windows/@1/panes/%252')).toBe('self');
    expect(parseNodeIdFromPath('/n/../devices/d1')).toBe('self');
  });
});
