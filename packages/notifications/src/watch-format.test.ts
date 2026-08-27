import { describe, expect, test } from 'bun:test';
import { formatWatchTriggeredNotification } from './watch-format';

const t = (key: string) => key;

describe('formatWatchTriggeredNotification', () => {
  test('规则名缺失回退 i18n 标题', () => {
    const r = formatWatchTriggeredNotification(null, { summary: 'hit' }, t);
    expect(r.title).toBe('watch.toast.triggeredTitle');
    expect(r.description).toBe('hit');
  });

  test('summary 优先于 matchedText', () => {
    const r = formatWatchTriggeredNotification('rule', { summary: 's', matchedText: 'm' }, t);
    expect(r.title).toBe('rule');
    expect(r.description).toBe('s');
  });

  test('超过 200 字符截断加省略号', () => {
    const long = 'x'.repeat(250);
    const r = formatWatchTriggeredNotification('rule', { matchedText: long }, t);
    expect(r.description.length).toBe(201);
    expect(r.description.endsWith('…')).toBe(true);
  });

  test('无内容时描述为空串', () => {
    const r = formatWatchTriggeredNotification('rule', {}, t);
    expect(r.description).toBe('');
  });
});
