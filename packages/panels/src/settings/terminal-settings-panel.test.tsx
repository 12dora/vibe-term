import { beforeEach, describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18N_RESOURCES } from '@vibeterm/shared';
import { createAppRuntime } from '@vibeterm/stores';
import { RuntimeProvider } from '@vibeterm/stores/react';
import { installWindowStorage } from '@vibeterm/stores/test-utils';
import i18next from 'i18next';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { TerminalSettingsPanel } from './terminal-settings-panel';

installWindowStorage();

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

let runtimeSeq = 0;

function render(node: ReactElement): string {
  const runtime = createAppRuntime({
    nodeId: 'self',
    storagePrefix: `terminal-settings-panel-${runtimeSeq++}:`,
  });
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient()}>
        <RuntimeProvider runtime={runtime}>{node}</RuntimeProvider>
      </QueryClientProvider>
    </I18nextProvider>
  );
}

describe('TerminalSettingsPanel copy mode', () => {
  beforeEach(() => {
    runtimeSeq += 1;
  });

  test('渲染复制方式选项，默认选中按钮复制', () => {
    const html = render(<TerminalSettingsPanel showPreview={false} showShortcuts={false} />);
    expect(html).toContain('data-testid="copy-mode-option-auto"');
    expect(html).toContain('data-testid="copy-mode-option-button"');
    const button = html.match(/<button[^>]*data-testid="copy-mode-option-button"[^>]*>/)?.[0] ?? '';
    expect(button).toContain('aria-pressed="true"');
    const auto = html.match(/<button[^>]*data-testid="copy-mode-option-auto"[^>]*>/)?.[0] ?? '';
    expect(auto).toContain('aria-pressed="false"');
  });

  test('复制方式两项横排等宽，键盘行为仍竖排', () => {
    const html = render(<TerminalSettingsPanel showPreview={false} showShortcuts={false} />);
    expect(html).toContain('点击按钮后复制');
    expect(html).toContain('选中后自动复制');
    const copyList = html.match(/<div[^>]*data-testid="copy-mode-option-list"[^>]*>/)?.[0] ?? '';
    expect(copyList).toContain('data-layout="row"');
    expect(copyList).toContain('flex-row');
    expect(copyList).toContain('flex-wrap');
    const copyButton =
      html.match(/<button[^>]*data-testid="copy-mode-option-button"[^>]*>/)?.[0] ?? '';
    expect(copyButton).toContain('min-w-[11rem]');
    expect(copyButton).toContain('flex-1');
    const keyboardList =
      html.match(/<div[^>]*data-testid="keyboard-behavior-option-list"[^>]*>/)?.[0] ?? '';
    expect(keyboardList).toContain('data-layout="column"');
    expect(keyboardList).toContain('flex-col');
    expect(keyboardList).not.toContain('flex-row');
  });
});
