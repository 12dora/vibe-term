import { describe, expect, mock, test } from 'bun:test';
import type { HostServices } from '@vibeterm/stores';
import { installWindowStorage } from '@vibeterm/stores/test-utils';
import { renderToStaticMarkup } from 'react-dom/server';
import * as ReactI18nRuntime from 'react-i18next';

installWindowStorage();

mock.module('react-i18next', () => ({
  ...ReactI18nRuntime,
  useTranslation: () => ({ t: (key: string) => key, i18n: {}, ready: true }),
}));

const { createAppRuntime } = await import('@vibeterm/stores');
const { RuntimeProvider } = await import('@vibeterm/stores/react');
const { PREVIEW_ANSI, TerminalPreview, writeTerminalPreviewContent } = await import(
  './TerminalPreview'
);

function recordingHost(): HostServices {
  return {
    navigate: () => {},
    isMobile: () => false,
    openMobileSidebar: () => {},
    closeMobileSidebar: () => {},
    writeClipboardText: async () => {},
    readClipboardText: async () => '',
    openExternal: () => {},
    reload: () => {},
    saveFile: async () => {},
  };
}

describe('TerminalPreview', () => {
  test('onReady 写入 PREVIEW_ANSI', () => {
    const writes: Array<string | Uint8Array> = [];
    writeTerminalPreviewContent({
      write: (data) => {
        writes.push(data);
      },
      resize: () => {},
      reset: () => {},
      fit: () => {},
      scrollToOrigin: () => {},
    });
    expect(writes).toEqual([PREVIEW_ANSI]);
    expect(PREVIEW_ANSI).toContain('你好，世界');
  });

  test('仍渲染固定 12 行外框与预览 testid', () => {
    const runtime = createAppRuntime({
      nodeId: 'self',
      storagePrefix: `terminal-preview-${Date.now()}:`,
      host: recordingHost(),
    });
    runtime.stores.ui.getState().setTerminalFontSize(13);
    runtime.stores.ui.getState().setTerminalLineHeight(1.2);
    const html = renderToStaticMarkup(
      <RuntimeProvider runtime={runtime}>
        <TerminalPreview />
      </RuntimeProvider>
    );
    expect(html).toContain('data-testid="terminal-preview"');
    expect(html).toContain('data-testid="terminal-preview-mount"');
    expect(html).toContain('aria-label="settings.terminal.preview"');
    expect(html).toContain('<section');
    expect(html).toContain(`height:${Math.ceil(13 * 1.2 * 12)}px`);
    runtime.dispose();
  });
});
