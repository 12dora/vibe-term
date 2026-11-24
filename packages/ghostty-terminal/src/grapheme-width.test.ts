import { afterAll, describe, expect, test } from 'bun:test';
import { restoreRealTerminalModules } from './test-support/fake-dom';

afterAll(() => {
  restoreRealTerminalModules();
});

let importVersion = 0;

async function createProbe() {
  restoreRealTerminalModules();
  importVersion += 1;
  const { getGhosttyBindings } = await import('./ghostty-wasm');
  const { GraphemeWidthProbe } = await import(
    `./grapheme-width.ts?grapheme-width=${importVersion}`
  );
  return new GraphemeWidthProbe(await getGhosttyBindings());
}

describe('GraphemeWidthProbe（内核 widthKind 作为宽度来源）', () => {
  test('可打印 ASCII 恒为 1 列', async () => {
    const probe = await createProbe();
    for (const text of ['a', 'Z', ' ', '~', '0']) {
      expect(probe.width(text)).toBe(1);
    }
    probe.dispose();
  });

  test('CJK / 全角 / emoji 为 2 列，拉丁重音与半角假名为 1 列', async () => {
    const probe = await createProbe();
    for (const text of ['中', 'あ', '한', 'Ａ', '😀']) {
      expect(probe.width(text)).toBe(2);
    }
    for (const text of ['é', 'ß', 'ｱ']) {
      expect(probe.width(text)).toBe(1);
    }
    probe.dispose();
  });

  test('重复查询命中缓存且结果稳定；探测不会把上一个字符的残留带进下一次', async () => {
    const probe = await createProbe();
    expect(probe.width('中')).toBe(2);
    expect(probe.width('é')).toBe(1);
    expect(probe.width('中')).toBe(2);
    expect(probe.width('é')).toBe(1);
    probe.dispose();
  });

  test('空串与控制字符不进探测，按 1 列处理', async () => {
    const probe = await createProbe();
    expect(probe.width('')).toBe(1);
    expect(probe.width('\u001b[31m')).toBe(1);
    expect(probe.width('\n')).toBe(1);
    expect(probe.width('\u0085')).toBe(1);
    probe.dispose();
  });

  test('dispose 幂等，释放后非 ASCII 退化为 1 列', async () => {
    const probe = await createProbe();
    expect(probe.width('中')).toBe(2);
    probe.dispose();
    probe.dispose();
    expect(probe.width('中')).toBe(1);
    expect(probe.width('a')).toBe(1);
  });
});
