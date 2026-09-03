// 工具卡片的详情 Dialog 只在打开后才挂载：工具密集会话里一屏上百张卡，
// 常驻的 Dialog root 是纯浪费。用 mock 包住 @tmex/ui/dialog（转发真实实现）数挂载次数。

import { describe, expect, mock, test } from 'bun:test';
import { I18N_RESOURCES } from '@tmex/shared';
import type { UiToolCall } from '@tmex/stores';
import i18next from 'i18next';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';

const realDialog = (await import('@tmex/ui/dialog')) as unknown as Record<string, unknown>;
const RealDialog = realDialog.Dialog as ComponentType<Record<string, unknown>>;

const mounts = { roots: 0 };

mock.module('@tmex/ui/dialog', () => ({
  ...realDialog,
  Dialog: (props: Record<string, unknown>) => {
    mounts.roots += 1;
    return <RealDialog {...props} />;
  },
}));

const { ToolCallCard } = await import('./tool-call-card');

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

function call(index: number): UiToolCall {
  return {
    toolCallId: `tc-${index}`,
    toolName: 'run_command',
    input: { command: 'ls -al' },
    output: { text: 'ok' },
    isError: false,
    denied: false,
    resolved: true,
  };
}

describe('ToolCallCard 详情 Dialog', () => {
  test('未打开的卡片不挂载 Dialog root', () => {
    const before = mounts.roots;
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <div>
          {Array.from({ length: 50 }, (_, index) => call(index)).map((toolCall) => (
            <ToolCallCard key={toolCall.toolCallId} call={toolCall} />
          ))}
        </div>
      </I18nextProvider>
    );
    expect(mounts.roots - before).toBe(0);
    expect(html).toContain('data-testid="agent-tool-card-tc-0"');
    expect(html).toContain('ls -al');
  });
});
