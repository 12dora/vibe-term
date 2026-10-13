// 设备卡片网格的列模型：骨架与真实网格共用同一套类名，磁贴里换成均分宽度的变体。

import { describe, expect, test } from 'bun:test';
import { I18N_RESOURCES } from '@vibeterm/shared';
import i18next from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import {
  DEVICE_GRID_CLASS,
  DEVICE_GRID_FIT_CLASS,
  DeviceCardSkeleton,
  deviceGridClass,
} from './device-card-skeleton';

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

/** 含 `marker` 的那个元素的整段开标签 */
function tagOf(html: string, marker: string): string {
  const index = html.indexOf(marker);
  expect(index).toBeGreaterThanOrEqual(0);
  return html.slice(html.lastIndexOf('<', index), html.indexOf('>', index));
}

describe('deviceGridClass', () => {
  test('缺省按固定最小列宽自动填列：每列至少 20rem，窄于它退回单列', () => {
    expect(deviceGridClass()).toBe(DEVICE_GRID_CLASS);
    expect(deviceGridClass(false)).toBe(DEVICE_GRID_CLASS);
    expect(DEVICE_GRID_CLASS).toContain('repeat(auto-fill,minmax(min(20rem,100%),1fr))');
  });

  test('fit：空轨道收掉，卡片均分宽度；最小列宽与间距和缺省一致', () => {
    expect(deviceGridClass(true)).toBe(DEVICE_GRID_FIT_CLASS);
    expect(DEVICE_GRID_FIT_CLASS).toContain('repeat(auto-fit,minmax(min(20rem,100%),1fr))');
    expect(DEVICE_GRID_FIT_CLASS.replace('auto-fit', 'auto-fill')).toBe(DEVICE_GRID_CLASS);
  });
});

describe('DeviceCardSkeleton', () => {
  test('骨架用的就是网格的类名，fit 时跟着换', () => {
    const plain = tagOf(render(<DeviceCardSkeleton />), 'data-testid="devices-loading"');
    expect(plain).toContain('auto-fill');
    const fit = tagOf(render(<DeviceCardSkeleton fit />), 'data-testid="devices-loading"');
    expect(fit).toContain('auto-fit');
    expect(fit).not.toContain('auto-fill');
  });

  test('count 决定占位卡片数量，至少一张', () => {
    const count = (html: string) => html.split('aria-hidden="true"').length - 1;
    expect(count(render(<DeviceCardSkeleton />))).toBe(1);
    expect(count(render(<DeviceCardSkeleton count={3} />))).toBe(3);
    expect(count(render(<DeviceCardSkeleton count={0} />))).toBe(1);
  });
});
