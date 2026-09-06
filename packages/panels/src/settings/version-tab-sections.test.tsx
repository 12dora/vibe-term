// 「关于」卡：卡头的检查更新按钮、信息行的取值与加载态、出处三行（版权 / 许可证 / 项目地址）。
// bun test 无 DOM，用 react-dom/server 静态渲染断言 HTML；系统信息直接种进 QueryClient。

import { describe, expect, test } from 'bun:test';
import type { SystemInfo } from '@vibeterm/shared';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

installWindowStorage();

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { I18N_RESOURCES } = await import('@vibeterm/shared');
const { createAppRuntime } = await import('@vibeterm/stores');
const { RuntimeProvider } = await import('@vibeterm/stores/react');
const i18next = (await import('i18next')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { I18nextProvider } = await import('react-i18next');
const { VersionTab } = await import('./version-tab');

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const INFO: SystemInfo = {
  version: '2.0.0',
  baseVersion: '2.0.0',
  isProd: true,
  installedViaCli: true,
  installSource: 'install-script',
  deployment: 'launchd',
  canSelfUpdate: true,
  serviceName: 'vibeterm',
  transferMaxBytes: 1024,
};

let storageSeq = 0;

function render(options: { info?: SystemInfo; runMode?: string } = {}): string {
  const runtime = createAppRuntime({ storagePrefix: `version-tab-test-${storageSeq++}:` });
  const queryClient = new QueryClient();
  if (options.info) queryClient.setQueryData(['system-info'], options.info);
  const html = renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <RuntimeProvider runtime={runtime}>
          <VersionTab runMode={options.runMode} />
        </RuntimeProvider>
      </QueryClientProvider>
    </I18nextProvider>
  );
  runtime.dispose();
  return html;
}

describe('「关于」卡的卡头', () => {
  test('标题是「关于」，检查更新与标题同一行（排在信息行之前）', () => {
    const html = render({ info: INFO });
    expect(html).toContain('关于');
    expect(html).not.toContain('版本与更新');
    expect(html).toContain('data-testid="settings-version-check"');
    expect(html).toContain('data-slot="card-action"');
    expect(html.indexOf('settings-version-check')).toBeLessThan(
      html.indexOf('settings-version-current')
    );
  });
});

describe('「关于」卡的信息行', () => {
  test('安装方式按来源逐档展示', () => {
    expect(render({ info: INFO })).toContain('安装脚本');
    expect(render({ info: { ...INFO, installSource: 'npx' } })).toContain('npx');
    expect(render({ info: { ...INFO, installSource: 'manual' } })).toContain('手动或容器');
  });

  test('老网关不下发安装来源：有 CLI 安装产物按 CLI，没有按手动或容器', () => {
    const legacy = { ...INFO, installSource: undefined };
    const html = render({ info: legacy });
    expect(html).toContain('>CLI<');
    expect(render({ info: { ...legacy, installedViaCli: false } })).toContain('手动或容器');
  });

  test('服务一行是 launchd / systemd，与运行模式分开两行', () => {
    const html = render({ info: INFO, runMode: 'Hub 兼节点' });
    expect(html).toContain('服务');
    expect(html).toContain('launchd（macOS）');
    expect(html).toContain('运行模式');
    expect(html).toContain('Hub 兼节点');
  });

  test('运行模式还没查到时显示加载中', () => {
    const html = render({ info: INFO });
    expect(html).toContain('data-testid="settings-version-role"');
    expect(html).toContain('加载中...');
  });

  test('系统信息未到：版本格加载中，其余给一杠', () => {
    const html = render();
    expect(html).toContain('加载中...');
    expect(html).toContain('>-<');
  });
});

describe('「关于」卡的出处', () => {
  test('版权与致谢一行，tmex 链到上游仓库', () => {
    const html = render({ info: INFO });
    expect(html).toContain('© 2026 12dora');
    expect(html).toContain('href="https://github.com/krhougs/tmex"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain('tmex');
  });

  test('许可证 MIT，项目地址链到本仓库', () => {
    const html = render({ info: INFO });
    expect(html).toContain('许可证');
    expect(html).toContain('MIT');
    expect(html).toContain('href="https://github.com/12dora/vibe-term"');
  });
});
