import { describe, expect, test } from 'bun:test';
import {
  extractUserMessageText,
  maybeGenerateSessionTitle,
  normalizeGeneratedTitle,
} from './title-generation';

describe('extractUserMessageText', () => {
  test('string / text parts / 其它', () => {
    expect(extractUserMessageText('hello')).toBe('hello');
    expect(
      extractUserMessageText([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
        { type: 'x' },
      ])
    ).toBe('a b ');
    expect(extractUserMessageText(null)).toBe('');
    expect(extractUserMessageText({ text: 'nope' })).toBe('');
  });
});

describe('normalizeGeneratedTitle', () => {
  test('去首尾引号并截断 80', () => {
    expect(normalizeGeneratedTitle('  "Check Disk"  ')).toBe('Check Disk');
    expect(normalizeGeneratedTitle('「标题」')).toBe('标题');
    expect(normalizeGeneratedTitle(`${'x'.repeat(90)}`)).toHaveLength(80);
  });
});

describe('maybeGenerateSessionTitle', () => {
  test('已有自定义标题则不生成', async () => {
    let generated = 0;
    await maybeGenerateSessionTitle({
      currentTitle: 'My Title',
      messages: [{ role: 'user', content: { content: 'hello' } }],
      generate: async () => {
        generated += 1;
        return 'Nope';
      },
      apply: () => {
        throw new Error('should not apply');
      },
    });
    expect(generated).toBe(0);
  });

  test('默认标题时用首条 user 文本生成并 apply 规范化结果', async () => {
    const applied: string[] = [];
    await maybeGenerateSessionTitle({
      currentTitle: 'New Session',
      messages: [
        { role: 'assistant', content: { content: 'ignore' } },
        { role: 'user', content: { content: 'check disk usage' } },
      ],
      generate: async (prompt) => {
        expect(prompt).toContain('check disk usage');
        return '"Check Disk Usage"';
      },
      apply: (title) => {
        applied.push(title);
      },
    });
    expect(applied).toEqual(['Check Disk Usage']);
  });

  test('无 user / 空文本 / 空标题 / 生成失败均静默', async () => {
    const applied: string[] = [];
    await maybeGenerateSessionTitle({
      currentTitle: 'New Session',
      messages: [{ role: 'assistant', content: { content: 'x' } }],
      generate: async () => 'T',
      apply: (title) => applied.push(title),
    });
    await maybeGenerateSessionTitle({
      currentTitle: 'New Session',
      messages: [{ role: 'user', content: { content: '   ' } }],
      generate: async () => 'T',
      apply: (title) => applied.push(title),
    });
    await maybeGenerateSessionTitle({
      currentTitle: 'New Session',
      messages: [{ role: 'user', content: { content: 'hi' } }],
      generate: async () => '   ',
      apply: (title) => applied.push(title),
    });
    await maybeGenerateSessionTitle({
      currentTitle: 'New Session',
      messages: [{ role: 'user', content: { content: 'hi' } }],
      generate: async () => {
        throw new Error('title model unavailable');
      },
      apply: (title) => applied.push(title),
    });
    expect(applied).toEqual([]);
  });
});
