import { describe, expect, test } from 'bun:test';
import {
  createTelegramAdapter,
  createWeixinAdapter,
  escapeHtml,
  renderPlain,
  renderTelegramHtml,
} from './adapter';

describe('escapeHtml', () => {
  test('escapes &, < and >', () => {
    expect(escapeHtml('a <b> & c')).toBe('a &lt;b&gt; &amp; c');
  });
});

describe('telegram adapter', () => {
  test('escapes text and wraps code sections', () => {
    const chunks = renderTelegramHtml(
      {
        text: 'see <x>',
        sections: [{ title: 'out', code: true, lines: ['if a < b'] }],
        actions: [{ label: 'Help', command: 'help' }],
      },
      4000
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('see &lt;x&gt;');
    expect(chunks[0]).toContain('<b>out</b>');
    expect(chunks[0]).toContain('<pre>if a &lt; b</pre>');
    expect(chunks[0]).toContain('help — Help');
  });

  test('chunks long HTML at the limit', () => {
    const adapter = createTelegramAdapter();
    const chunks = adapter.render({ text: 'x'.repeat(5000) });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
    expect(chunks.join('')).toBe('x'.repeat(5000));
  });
});

describe('weixin adapter', () => {
  test('renders plain text and chunks at 2000', () => {
    const adapter = createWeixinAdapter();
    expect(adapter.limits.maxTextChars).toBe(2000);
    const chunks = adapter.render({
      sections: [{ title: 'Devices', lines: ['a', 'b'] }],
    });
    expect(chunks).toEqual(['Devices\na\nb']);
    const long = renderPlain({ text: 'y'.repeat(2500) }, 2000);
    expect(long.length).toBeGreaterThan(1);
    expect(long.every((chunk) => chunk.length <= 2000)).toBe(true);
  });
});
