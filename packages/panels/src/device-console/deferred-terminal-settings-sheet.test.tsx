// 终端设置面板的懒加载兜底：发版后 iOS PWA 拿着缓存的 index.html，旧 hash chunk 会一直 404，
// 就地重试救不回来，兜底条必须给出「重新加载应用」。bun test 无 DOM，用 react-dom/server
// 静态渲染断言按钮是否就位。新增的 i18n key 由 build:i18n 生成，测试里未编译进 I18N_RESOURCES
// 时 i18next 会回落成 key 本身，因此断言按 data-testid 而非文案。

import { describe, expect, test } from 'bun:test';
import { I18N_RESOURCES } from '@tmex/shared';
import i18next from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import {
  DeferredTerminalSettingsSheet,
  MAX_SHEET_LOAD_RETRIES,
  TerminalSettingsFallback,
  terminalSettingsFallbackView,
} from './deferred-terminal-settings-sheet';

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

const noop = () => {};

describe('terminalSettingsFallbackView', () => {
  test('未失败时是 loading 状态，不给任何恢复按钮', () => {
    const view = terminalSettingsFallbackView(0);
    expect(view).toEqual({
      role: 'status',
      messageKey: 'settings.terminal.loading',
      showRetry: false,
      showReload: false,
    });
  });

  test('首次失败即给出重试 + 重新加载，并附带新版本提示', () => {
    const view = terminalSettingsFallbackView(1);
    expect(view.role).toBe('alert');
    expect(view.messageKey).toBe('settings.terminal.loadFailed');
    expect(view.hintKey).toBe('settings.terminal.loadFailedHint');
    expect(view.showRetry).toBe(true);
    expect(view.showReload).toBe(true);
  });

  test('重试到上限后只留整页刷新', () => {
    const view = terminalSettingsFallbackView(MAX_SHEET_LOAD_RETRIES);
    expect(view.showRetry).toBe(false);
    expect(view.showReload).toBe(true);
    expect(terminalSettingsFallbackView(MAX_SHEET_LOAD_RETRIES + 5).showRetry).toBe(false);
  });
});

describe('TerminalSettingsFallback', () => {
  test('loading 态只有关闭按钮，role=status', () => {
    const html = render(
      <TerminalSettingsFallback
        view={terminalSettingsFallbackView(0)}
        onRetry={noop}
        onReload={noop}
        onClose={noop}
      />
    );
    expect(html).toContain('role="status"');
    expect(html).not.toContain('terminal-settings-retry');
    expect(html).not.toContain('terminal-settings-reload');
  });

  test('首次失败渲染重试与重新加载按钮，role=alert', () => {
    const html = render(
      <TerminalSettingsFallback
        view={terminalSettingsFallbackView(1)}
        onRetry={noop}
        onReload={noop}
        onClose={noop}
      />
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('terminal-settings-retry');
    expect(html).toContain('terminal-settings-reload');
  });

  test('重试耗尽后只剩重新加载按钮', () => {
    const html = render(
      <TerminalSettingsFallback
        view={terminalSettingsFallbackView(MAX_SHEET_LOAD_RETRIES)}
        onRetry={noop}
        onReload={noop}
        onClose={noop}
      />
    );
    expect(html).not.toContain('terminal-settings-retry');
    expect(html).toContain('terminal-settings-reload');
  });
});

describe('DeferredTerminalSettingsSheet', () => {
  test('未打开时不渲染任何兜底条', () => {
    const html = render(<DeferredTerminalSettingsSheet open={false} onOpenChange={noop} />);
    expect(html).toBe('');
  });

  test('打开且 chunk 未就绪时先渲染 loading 兜底条', () => {
    const html = render(<DeferredTerminalSettingsSheet open onOpenChange={noop} />);
    expect(html).toContain('terminal-settings-fallback');
    expect(html).toContain('role="status"');
  });
});
