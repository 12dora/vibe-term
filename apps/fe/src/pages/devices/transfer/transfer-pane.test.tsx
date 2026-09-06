// 面板渲染：发送按钮带目标节点名且单行截断，零文件根时根目录下拉落到虚拟根 `/`。
// 无 DOM 环境，用 react-dom/server 静态渲染。
//
// 同一次 `bun test` 里 FilePage 的用例把 `react-i18next` / `@tanstack/react-query` 整体 mock 掉了
// （进程级），所以这里的断言一律只落在「不经 t()、不经查询」的那部分：按钮文案来自 props，
// 根目录下拉直接喂 props 渲染，i18n 文案用自建实例单独核对。

import { describe, expect, test } from 'bun:test';
import { I18N_RESOURCES, VIRTUAL_FS_ROOT_ID } from '@vibeterm/shared';
import { installWindowStorage } from '@vibeterm/stores/test-utils';
import type { DialogNodeOption } from '../dialog-nodes';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createInstance } = await import('i18next');
const { TransferPane } = await import('./transfer-pane');
const { PaneRootSelect } = await import('./pane-toolbar');
const { createTransferPaneState } = await import('./pane-state');
const { VIRTUAL_FS_ROOT, paneRoots } = await import('./pane-roots');

const REMOTE = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';

const OPTIONS: DialogNodeOption[] = [
  {
    id: 'self',
    meshId: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e',
    name: '本机',
    online: true,
    loggedIn: true,
    isSelf: true,
    usable: true,
  },
  {
    id: REMOTE,
    meshId: REMOTE,
    name: 'mesh-node-b',
    online: true,
    loggedIn: true,
    isSelf: false,
    usable: true,
  },
];

async function i18nFor(lng: string) {
  const instance = createInstance();
  await instance.init({
    lng,
    fallbackLng: 'zh_CN',
    ns: ['translation'],
    defaultNS: 'translation',
    resources: I18N_RESOURCES,
    interpolation: { escapeValue: false },
  });
  return instance;
}

function renderPane(sendLabel: string): string {
  const state = { ...createTransferPaneState('self'), rootId: VIRTUAL_FS_ROOT_ID, path: '/' };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <TransferPane
        side="left"
        state={state}
        dispatch={() => undefined}
        nodeOptions={OPTIONS}
        sendLabel={sendLabel}
        sendBlockedReason={null}
        sending={false}
        busy={false}
        onSend={() => undefined}
      />
    </QueryClientProvider>
  );
}

function sendButton(markup: string): string {
  const at = markup.indexOf('data-testid="transfer-pane-left-send"');
  expect(at).toBeGreaterThan(-1);
  return markup.slice(at, at + 1600);
}

describe('TransferPane 发送按钮', () => {
  test('文案带目标节点名，且单行截断', async () => {
    const i18n = await i18nFor('zh_CN');
    const label = i18n.t('devices.transfer.sendTo', { node: 'mesh-node-b' });
    expect(label).toBe('发送到 mesh-node-b');
    const button = sendButton(renderPane(label));
    expect(button).toContain('发送到 mesh-node-b');
    expect(button).toContain('truncate');
    // 名字太长被截断时，悬停仍能看到全文
    expect(button).toContain('title="发送到 mesh-node-b"');
  });

  test('英日文案同样带节点名', async () => {
    const en = await i18nFor('en_US');
    expect(en.t('devices.transfer.sendTo', { node: 'mesh-node-b' })).toBe('Send to mesh-node-b');
    const ja = await i18nFor('ja_JP');
    expect(ja.t('devices.transfer.sendTo', { node: 'mesh-node-b' })).toBe('mesh-node-b へ送信');
  });
});

describe('根目录下拉的虚拟根', () => {
  test('节点没有配置文件根时，缺省项就是 /', () => {
    const roots = paneRoots([]);
    // 面板的自动选中取 roots[0]
    expect(roots[0]).toMatchObject({ id: VIRTUAL_FS_ROOT_ID, name: '/' });
    const markup = renderToStaticMarkup(
      <PaneRootSelect
        roots={roots}
        value={VIRTUAL_FS_ROOT_ID}
        onChange={() => undefined}
        testId="transfer-pane-left-root"
      />
    );
    expect(markup).toContain('<span class="truncate">/</span>');
    // 不再落到「未配置文件目录」空态
    expect(markup).not.toContain('rootEmpty');
    expect(markup).not.toContain('未配置文件目录');
    expect(markup).not.toContain('disabled=""');
  });

  test('虚拟根的路径就是文件系统根', () => {
    expect(VIRTUAL_FS_ROOT.path).toBe('/');
  });
});
