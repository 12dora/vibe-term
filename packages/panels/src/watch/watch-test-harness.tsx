import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18N_RESOURCES, type WatchRuleDto } from '@tmex/shared';
import { type AppRuntime, createAppRuntime } from '@tmex/stores';
import { RuntimeProvider } from '@tmex/stores/react';
import { installWindowStorage } from '@tmex/stores/test-utils';
import i18next from 'i18next';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { initReactI18next } from 'react-i18next';

let ready = false;

/** bun test 无 DOM：用 react-dom/server 静态渲染断言组件输出与 query 数量 */
export async function setupWatchTestEnv(): Promise<void> {
  if (ready) {
    return;
  }
  installWindowStorage();
  await i18next.use(initReactI18next).init({
    lng: 'en_US',
    fallbackLng: 'en_US',
    resources: I18N_RESOURCES,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  ready = true;
}

let runtime: AppRuntime | null = null;

function testRuntime(): AppRuntime {
  if (!runtime) runtime = createAppRuntime();
  return runtime;
}

export function renderWatch(element: ReactElement): { html: string; client: QueryClient } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const html = renderToStaticMarkup(
    <RuntimeProvider runtime={testRuntime()}>
      <QueryClientProvider client={client}>{element}</QueryClientProvider>
    </RuntimeProvider>
  );
  return { html, client };
}

export function makeRule(overrides: Partial<WatchRuleDto> = {}): WatchRuleDto {
  return {
    id: 'r1',
    name: 'rule one',
    deviceId: 'd1',
    paneId: '%1',
    enabled: true,
    triggerType: 'match',
    pattern: 'ERROR',
    patternFlags: '',
    extractGroup: 0,
    conditionPrompt: null,
    providerId: null,
    modelId: null,
    confirmWithLlm: false,
    summarizeWithLlm: false,
    intervalSeconds: 30,
    unchangedMinutes: null,
    noMatchBehavior: 'reset',
    fireMode: 'once',
    cooldownSeconds: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}
