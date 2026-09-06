// 「关于」卡：卡头的检查更新按钮、抬头（logo / 产品名 / 版本）、运行状态一句话的拼法与省略、出处两行。
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
  test('标题是「关于」，检查更新与标题同一行（排在抬头之前）', () => {
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

describe('「关于」卡的抬头', () => {
  test('logo、产品名、一句定位、版本行；不再是一行一格的信息行', () => {
    const html = render({ info: INFO });
    expect(html).toContain('src="/logo.png"');
    expect(html).toContain('VibeTerm');
    expect(html).toContain('为 AI Agent 时代重造的 tmux 终端工作区。');
    expect(html).toContain('版本 2.0.0');
    expect(html).not.toContain('当前版本');
    expect(html).not.toContain('安装方式');
    expect(html).not.toContain('许可证</div>');
  });

  test('系统信息未到：版本行加载中，运行状态那句话不渲染', () => {
    const html = render();
    expect(html).toContain('加载中...');
    expect(html).not.toContain('settings-version-runtime');
  });
});

describe('「关于」卡的运行状态一句话', () => {
  const runtime = (html: string) =>
    html.match(/data-testid="settings-version-runtime"[^>]*>([^<]*)</)?.[1];

  test('安装方式、服务、运行模式拼成一句，英文两侧留空格', () => {
    expect(runtime(render({ info: INFO, runMode: 'Hub 兼节点' }))).toBe(
      '通过安装脚本安装，由 launchd（macOS）托管，当前为 Hub 兼节点。'
    );
  });

  test('安装来源逐档换子句', () => {
    expect(runtime(render({ info: { ...INFO, installSource: 'npx' } }))).toContain('通过 npx 安装');
    expect(runtime(render({ info: { ...INFO, installSource: 'manual' } }))).toContain(
      '手动或容器安装'
    );
  });

  test('老网关不下发安装来源：有 CLI 安装产物按 CLI，没有按手动或容器', () => {
    const legacy = { ...INFO, installSource: undefined };
    expect(runtime(render({ info: legacy }))).toContain('通过 CLI 安装');
    expect(runtime(render({ info: { ...legacy, installedViaCli: false } }))).toContain(
      '手动或容器安装'
    );
  });

  test('没注册系统服务写「未注册为系统服务」，运行模式没查到就省掉这一子句', () => {
    expect(runtime(render({ info: { ...INFO, deployment: 'none' } }))).toBe(
      '通过安装脚本安装，未注册为系统服务。'
    );
    expect(render({ info: INFO })).not.toContain('当前为');
  });
});

describe('「关于」卡的出处', () => {
  test('版权、致谢与许可证是一句话，tmex 链到上游仓库、MIT 链到 LICENSE', () => {
    const html = render({ info: INFO });
    expect(html).toContain('© 2026 12dora。基于 ');
    expect(html).toContain('href="https://github.com/krhougs/tmex"');
    expect(html).toContain('href="https://github.com/12dora/vibe-term/blob/main/LICENSE"');
    expect(html).toContain('MIT 许可证</a>发布。');
    expect(html).toContain('rel="noreferrer"');
  });

  test('项目地址一行链到本仓库', () => {
    const html = render({ info: INFO });
    expect(html).toContain('项目地址：');
    expect(html).toContain('href="https://github.com/12dora/vibe-term"');
    expect(html).toContain('github.com/12dora/vibe-term</a>');
  });
});
