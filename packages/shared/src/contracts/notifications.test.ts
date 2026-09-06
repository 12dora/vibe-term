import { describe, expect, test } from 'bun:test';
import { EVENT_TYPES, isEventType } from './notifications';

describe('isEventType', () => {
  test('收录全部事件类型', () => {
    expect(EVENT_TYPES).toContain('terminal_bell');
    expect(EVENT_TYPES).toContain('watch_rule_error');
    expect(EVENT_TYPES.every(isEventType)).toBe(true);
  });

  test('原型链上的键不算事件类型', () => {
    expect(isEventType('toString')).toBe(false);
    expect(isEventType('constructor')).toBe(false);
    expect(isEventType('__proto__')).toBe(false);
    expect(isEventType('nope')).toBe(false);
    expect(isEventType(1)).toBe(false);
  });
});
