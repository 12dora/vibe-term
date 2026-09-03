import { describe, expect, test } from 'bun:test';
import coreHljs from 'highlight.js/lib/core';
import { createHighlightEngine } from './highlight-engine';
import { type LanguageResolver, loadLanguageChunk } from './language-loaders';
import { AUTO_DETECT_LIMIT, HIGHLIGHT_LIMIT } from './language-map';
import { mainThreadHighlightEngine } from './main-thread-engine';

const SNIPPET = 'const a = 1; // <tag>\n';

function isolatedEngine(available: readonly string[] = ['typescript', 'javascript']) {
  const calls = new Map<string, number>();
  const loadLanguage: LanguageResolver = async (name) => {
    if (!available.includes(name)) {
      return null;
    }
    calls.set(name, (calls.get(name) ?? 0) + 1);
    return loadLanguageChunk(name);
  };
  const engine = createHighlightEngine({
    hljs: coreHljs.newInstance(),
    loadLanguage,
    autoDetectLanguages: ['javascript'],
  });
  return { engine, calls };
}

describe('按需注册语言', () => {
  test('已知扩展名只加载对应语言，且只加载一次', async () => {
    const { engine, calls } = isolatedEngine();
    const first = await engine.highlight(SNIPPET, 'a.ts');
    expect(first.html).toContain('hljs-keyword');
    expect(calls.get('typescript')).toBe(1);
    expect(calls.get('javascript')).toBeUndefined();

    const second = await engine.highlight('let b = 2;', 'b.ts');
    expect(second.html).toContain('hljs-keyword');
    expect(calls.get('typescript')).toBe(1);
  });

  test('并发请求同一语言不会重复加载', async () => {
    const { engine, calls } = isolatedEngine();
    await Promise.all([engine.highlight(SNIPPET, 'a.ts'), engine.highlight(SNIPPET, 'b.tsx')]);
    expect(calls.get('typescript')).toBe(1);
  });

  test('未知扩展名走自动识别子集', async () => {
    const { engine, calls } = isolatedEngine();
    const result = await engine.highlight(SNIPPET, 'notes.unknownext');
    expect(result.html).toContain('hljs-');
    expect(calls.get('javascript')).toBe(1);
    expect(calls.get('typescript')).toBeUndefined();
  });

  test('没有加载器的语言名（如 dockerfile）退回自动识别', async () => {
    const { engine, calls } = isolatedEngine();
    const result = await engine.highlight(SNIPPET, 'Dockerfile');
    expect(result.html).toContain('hljs-');
    expect(calls.get('javascript')).toBe(1);
  });

  test('加载失败时不高亮，且允许下次重试', async () => {
    let attempts = 0;
    const engine = createHighlightEngine({
      hljs: coreHljs.newInstance(),
      autoDetectLanguages: [],
      loadLanguage: (name) => {
        attempts++;
        return attempts === 1 ? Promise.reject(new Error('network')) : loadLanguageChunk(name);
      },
    });
    expect((await engine.highlight(SNIPPET, 'a.ts')).html).toBeNull();
    expect((await engine.highlight(SNIPPET, 'a.ts')).html).toContain('hljs-keyword');
    expect(attempts).toBe(2);
  });
});

describe('体积护栏', () => {
  test('已知语言超过 512 KiB 不高亮，也不去加载语言', async () => {
    const { engine, calls } = isolatedEngine();
    const code = SNIPPET.repeat(Math.ceil(HIGHLIGHT_LIMIT / SNIPPET.length) + 1);
    expect(code.length).toBeGreaterThan(HIGHLIGHT_LIMIT);
    expect((await engine.highlight(code, 'a.ts')).html).toBeNull();
    expect(calls.size).toBe(0);
  });

  test('未知扩展名超过 64 KiB 不做自动识别', async () => {
    const { engine, calls } = isolatedEngine();
    const code = SNIPPET.repeat(Math.ceil(AUTO_DETECT_LIMIT / SNIPPET.length) + 1);
    expect(code.length).toBeGreaterThan(AUTO_DETECT_LIMIT);
    expect((await engine.highlight(code, 'notes.unknownext')).html).toBeNull();
    expect(calls.size).toBe(0);
  });

  test('已知语言在 64 KiB 以上仍然高亮', async () => {
    const { engine } = isolatedEngine();
    expect((await engine.highlight(SNIPPET.repeat(4000), 'a.ts')).html).toContain('hljs-keyword');
  });
});

describe('主线程兜底引擎（整包语言表）', () => {
  test('按扩展名高亮', async () => {
    expect((await mainThreadHighlightEngine.highlight(SNIPPET, 'a.ts')).html).toContain(
      'hljs-keyword'
    );
    expect(
      (await mainThreadHighlightEngine.highlight('def f():\n  pass\n', 'a.py')).html
    ).toContain('hljs-keyword');
  });

  test('未知扩展名的小文件仍走自动识别', async () => {
    expect((await mainThreadHighlightEngine.highlight(SNIPPET, 'notes.unknownext')).html).toContain(
      'hljs-'
    );
  });
});
