import { describe, expect, test } from 'bun:test';
import { I18N_RESOURCES } from '@tmex/shared';
import type { UiToolCall } from '@tmex/stores';
import i18next from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';

import { ToolDetailsBody, extractToolImages, previewEnd } from './tool-call-card';

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

function call(toolName: string, output: unknown): UiToolCall {
  return {
    toolCallId: 'tc-1',
    toolName,
    input: { command: 'ls' },
    output,
    isError: false,
    denied: false,
    resolved: true,
  };
}

function renderDetails(toolCall: UiToolCall): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ToolDetailsBody call={toolCall} view={undefined} />
    </I18nextProvider>
  );
}

describe('previewEnd', () => {
  test('短文本不截断', () => {
    expect(previewEnd('')).toBe(0);
    expect(previewEnd('abc\ndef')).toBe(7);
  });

  test('按 64 KiB 截断', () => {
    expect(previewEnd('x'.repeat(200 * 1024))).toBe(64 * 1024);
  });

  test('行数先到时按第 2000 行末尾截断', () => {
    const text = 'a\n'.repeat(5000);
    expect(previewEnd(text)).toBe(4000);
    expect(text.slice(0, previewEnd(text)).split('\n')).toHaveLength(2001);
  });

  test('字符上限先到时不看行数', () => {
    // 每行 100 字符，2000 行远超 64 KiB
    const text = `${'a'.repeat(99)}\n`.repeat(2000);
    expect(previewEnd(text)).toBe(64 * 1024);
  });
});

describe('ToolDetailsBody 输出预览', () => {
  test('500 KiB 输出只挂载有界预览并给出提示与复制入口', () => {
    const html = renderDetails(call('run_command', 'B'.repeat(500 * 1024)));
    expect(html.length).toBeLessThan(100 * 1024);
    expect(html).toContain('data-testid="agent-tool-preview-note"');
    expect(html).toContain('仅显示前 65536 个字符（共 512000）');
    expect(html).toContain('复制完整输出');
    expect(html).not.toContain('B'.repeat(64 * 1024 + 1));
  });

  test('小输出原样渲染且不显示提示', () => {
    const html = renderDetails(call('run_command', 'hello world'));
    expect(html).toContain('hello world');
    expect(html).not.toContain('data-testid="agent-tool-preview-note"');
    expect(html).not.toContain('复制完整输出');
  });
});

describe('extractToolImages', () => {
  const dataUri = `data:image/png;base64,${'A'.repeat(512)}`;

  test('data URI 与图片 URL 对任何工具都识别', () => {
    expect(extractToolImages(call('run_command', dataUri))).toEqual([dataUri]);
    expect(extractToolImages(call('run_command', { image: 'https://a.example/x.png' }))).toEqual([
      'https://a.example/x.png',
    ]);
  });

  test('裸 base64 只对出图工具生效', () => {
    const raw = 'A'.repeat(1024);
    expect(extractToolImages(call('image_generation', { result: raw }))).toEqual([
      `data:image/png;base64,${raw}`,
    ]);
    expect(extractToolImages(call('run_command', { result: raw }))).toEqual([]);
  });

  test('超过 512 KiB 的值跳过探测', () => {
    expect(extractToolImages(call('image_generation', 'A'.repeat(512 * 1024 + 1)))).toEqual([]);
    expect(
      extractToolImages(call('run_command', `data:image/png;base64,${'A'.repeat(512 * 1024)}`))
    ).toEqual([]);
  });

  test('未完成/出错/被拒的调用不探测', () => {
    expect(extractToolImages({ ...call('run_command', dataUri), resolved: false })).toEqual([]);
    expect(extractToolImages({ ...call('run_command', dataUri), isError: true })).toEqual([]);
    expect(extractToolImages({ ...call('run_command', dataUri), denied: true })).toEqual([]);
  });
});
