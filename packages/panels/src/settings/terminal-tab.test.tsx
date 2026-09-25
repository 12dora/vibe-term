import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18N_RESOURCES } from '@vibeterm/shared';
import { createAppRuntime } from '@vibeterm/stores';
import { RuntimeProvider } from '@vibeterm/stores/react';
import { installWindowStorage } from '@vibeterm/stores/test-utils';
import i18next from 'i18next';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { TerminalSettingsTab } from './terminal-tab';

installWindowStorage();

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

let seq = 0;

function render(memoryLimits?: ReactNode): string {
  const runtime = createAppRuntime({ nodeId: 'self', storagePrefix: `terminal-tab-${seq++}:` });
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient()}>
        <RuntimeProvider runtime={runtime}>
          <TerminalSettingsTab memoryLimits={memoryLimits} />
        </RuntimeProvider>
      </QueryClientProvider>
    </I18nextProvider>
  );
}

describe('TerminalSettingsTab memory limits card', () => {
  test('传入内存限额时作为第三张卡挂在快捷键之后', () => {
    const html = render(<div data-testid="memory-slot" />);
    expect(html).toContain('data-testid="terminal-memory-limits"');
    expect(html).toContain('data-testid="memory-slot"');
    expect(html).toContain(i18n.t('settings.nodes.memory.title'));
    expect(html).toContain(i18n.t('settings.nodes.memory.description'));
    expect(html.indexOf('terminal-memory-limits')).toBeGreaterThan(
      html.indexOf(i18n.t('settings.terminal.shortcuts.title'))
    );
  });

  test('不传时不渲染这张卡', () => {
    const html = render();
    expect(html).not.toContain('terminal-memory-limits');
    expect(html).not.toContain(i18n.t('settings.nodes.memory.title'));
  });
});
