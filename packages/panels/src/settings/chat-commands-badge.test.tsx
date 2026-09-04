// 「允许聊天指令」徽标：仅在开启时出现，文案取自源 locale JSON（不依赖生成的 resources）。

import { describe, expect, test } from 'bun:test';
import zhCN from '@tmex/shared/i18n/locales/zh_CN.json';
import i18next from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';

import { ChatCommandsBadge } from './chat-commands-badge';

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: { zh_CN: zhCN },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

function render(namespace: 'telegram' | 'weixin', allowCommands: boolean): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ChatCommandsBadge
        namespace={namespace}
        allowCommands={allowCommands}
        testId={`${namespace}-commands-x1`}
      />
    </I18nextProvider>
  );
}

describe('ChatCommandsBadge', () => {
  test('关闭时不渲染任何内容', () => {
    expect(render('telegram', false)).toBe('');
    expect(render('weixin', false)).toBe('');
  });

  test('开启时渲染徽标，提示文案挂在 title 上', () => {
    const html = render('telegram', true);
    expect(html).toContain('data-testid="telegram-commands-x1"');
    expect(html).toContain(i18n.t('telegram.commandsBadge'));
    expect(html).toContain(i18n.t('telegram.allowCommandsHelp'));
  });

  test('微信命名空间取 weixin.* 文案', () => {
    const html = render('weixin', true);
    expect(html).toContain('data-testid="weixin-commands-x1"');
    expect(html).toContain(i18n.t('weixin.commandsBadge'));
  });

  test('源 locale 里两个渠道的聊天指令文案齐备', () => {
    for (const section of [zhCN.translation.telegram, zhCN.translation.weixin]) {
      expect(section.allowCommands.length).toBeGreaterThan(0);
      expect(section.allowCommandsHelp.length).toBeGreaterThan(0);
      expect(section.commandsBadge.length).toBeGreaterThan(0);
    }
  });
});
