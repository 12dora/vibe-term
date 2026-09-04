// 无 DOM 环境，用 react-dom/server 静态渲染断言结构（与 device-card.test.tsx 同一套做法）。
// 交互态（重命名 / 新建行）由外部 props 驱动的 FolderSection / FolderNameEditor 直接覆盖。

import { describe, expect, test } from 'bun:test';
import { type DeviceFolder, type DeviceFolderLayout, I18N_RESOURCES } from '@tmex/shared';
import i18next from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { DeviceFolderTree } from './device-folder-tree';
import { FolderNameEditor } from './folder-name-editor';
import { FolderSection } from './folder-section';
import {
  ROOT_CONTAINER_ID,
  bodyDropZoneId,
  dropZoneId,
  folderContainerId,
} from './folder-tree-model';

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

function renderMarkup(node: React.ReactElement): string {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

function folder(id: string, sortOrder: number): DeviceFolder {
  return {
    id,
    name: `folder-${id}`,
    sortOrder,
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
  };
}

const LAYOUT: DeviceFolderLayout = {
  folders: [folder('a', 0), folder('b', 1)],
  placements: [
    { nodeId: 'n1', folderId: 'a', sortOrder: 0 },
    { nodeId: 'n2', folderId: null, sortOrder: 0 },
  ],
};

function renderTree(
  overrides: Partial<React.ComponentProps<typeof DeviceFolderTree>> = {}
): string {
  return renderMarkup(
    <DeviceFolderTree
      layout={LAYOUT}
      implicitRootNodeIds={['self']}
      expanded={{}}
      nodeLabel={(nodeId) => `label:${nodeId}`}
      renderNode={(nodeId, ctx) => (
        <span data-testid={`rendered-${nodeId}`} data-in-folder={ctx.folderId ?? 'root'}>
          {ctx.dragControls}
        </span>
      )}
      onExpandedChange={() => undefined}
      onDrop={() => undefined}
      onCreateFolder={() => undefined}
      onRenameFolder={() => undefined}
      onDeleteFolder={() => undefined}
      {...overrides}
    />
  );
}

/** 含 `marker` 的那个元素的整段开标签 */
function tagOf(html: string, marker: string): string {
  const index = html.indexOf(marker);
  expect(index).toBeGreaterThanOrEqual(0);
  return html.slice(html.lastIndexOf('<', index), html.indexOf('>', index));
}

describe('DeviceFolderTree', () => {
  test('渲染分组、计数与节点外壳', () => {
    const html = renderTree();

    expect(html).toContain('data-testid="device-folder-tree"');
    expect(html).toContain('data-testid="device-folder-a"');
    expect(html).toContain('data-testid="device-folder-b"');
    expect(html).toContain('data-testid="device-folder-toggle-a"');
    expect(html).toContain('data-testid="device-folder-name-a"');
    expect(html).toContain('data-testid="device-folder-menu-a"');
    expect(html).toContain('data-testid="device-folder-item-node:n1"');
    expect(html).toContain('data-testid="device-folder-item-node:n2"');
    expect(html).toContain('data-testid="device-folder-item-node:self"');
    expect(html).toContain('data-in-folder="a"');
  });

  test('分组是虚线边框的放置区', () => {
    expect(tagOf(renderTree(), 'data-testid="device-folder-a"')).toContain('border-dashed');
  });

  test('把手交给宿主放进节点头部；「移出分组」按钮已删除（改为拖到空白处）', () => {
    const html = renderTree();
    const n1 = html.slice(
      html.indexOf('data-testid="rendered-n1"'),
      html.indexOf('data-testid="rendered-n2"')
    );
    expect(n1).toContain('data-testid="device-folder-handle-n1"');
    const n2 = html.slice(html.indexOf('data-testid="rendered-n2"'));
    expect(n2).toContain('data-testid="device-folder-handle-n2"');
    expect(html).not.toContain('device-folder-move-out-');
    expect(html).not.toContain(i18n.t('devices.folders.moveToRoot'));
  });

  test('隐式根节点排在显式 placement 之后', () => {
    const html = renderTree();
    expect(html.indexOf('data-testid="device-folder-item-node:n2"')).toBeLessThan(
      html.indexOf('data-testid="device-folder-item-node:self"')
    );
  });

  test('空分组渲染虚线放置提示，非空的不渲染', () => {
    const html = renderTree();
    expect(html).toContain('data-testid="device-folder-drop-b"');
    expect(html).not.toContain('data-testid="device-folder-drop-a"');
  });

  test('不再有「移到最外层」落点条：整棵树自己就是根落点区', () => {
    const html = renderTree();
    expect(html).not.toContain('data-testid="device-folder-drop-root"');
    expect(html).not.toContain(i18n.t('devices.folders.dropToRoot'));
    // `data-drop-zone` 与 `useDroppable` 由 `useDropZone` 一并给出：
    // 树容器上没这个属性就说明根落点区压根没注册，节点也就再没有办法拖回最外层。
    expect(tagOf(html, 'data-testid="device-folder-tree"')).toContain(
      `data-drop-zone="${dropZoneId(ROOT_CONTAINER_ID)}"`
    );
  });

  test('分组头与空分组内容区各自注册了落点', () => {
    const html = renderTree();
    // 分组头（`drop:`）：整段头部都能接住节点
    expect(html).toContain(`data-drop-zone="${dropZoneId(folderContainerId('a'))}"`);
    // 空分组的内容区（`dropin:`）：分组 b 是空的
    expect(tagOf(html, 'data-testid="device-folder-drop-b"')).toContain(
      `data-drop-zone="${bodyDropZoneId(folderContainerId('b'))}"`
    );
  });

  test('没在拖拽时不渲染占位条', () => {
    expect(renderTree()).not.toContain('data-testid="device-folder-drop-placeholder"');
  });

  test('分组菜单里没有「新建子分组」', () => {
    const html = renderTree();
    expect(html).not.toContain('device-folder-new-sub-');
    expect(html).not.toContain(i18n.t('devices.folders.newSubfolder'));
  });

  test('nodeDraggable 返回 false 的节点不套拖拽把手', () => {
    const html = renderTree({ nodeDraggable: (nodeId) => nodeId !== 'self' });
    const index = html.indexOf('data-testid="device-folder-item-node:self"');
    const slice = html.slice(index);
    expect(slice).toContain('data-testid="rendered-self"');
    expect(slice).not.toContain(i18n.t('devices.folders.dragHandle'));
  });

  test('初始就收起的分组不挂载内容，并标记 aria-hidden', () => {
    const html = renderTree({ expanded: { a: false } });
    expect(tagOf(html, 'data-testid="device-folder-a"')).toContain('data-expanded="false"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('data-testid="device-folder-item-node:n1"');
  });

  test('没有分组也没有节点时只渲染空树容器', () => {
    const html = renderTree({
      layout: { folders: [], placements: [] },
      implicitRootNodeIds: [],
    });
    expect(html).toContain('data-testid="device-folder-tree"');
    expect(html).not.toContain('data-testid="device-folder-item-');
  });
});

describe('FolderSection', () => {
  function renderSection(overrides: Partial<React.ComponentProps<typeof FolderSection>> = {}) {
    return renderMarkup(
      <FolderSection
        folder={folder('a', 0)}
        itemCount={3}
        expanded={true}
        renaming={false}
        dragDisabled={false}
        dropTarget={false}
        onToggle={() => undefined}
        onStartRename={() => undefined}
        onSubmitRename={() => undefined}
        onCancelRename={() => undefined}
        onDelete={() => undefined}
        {...overrides}
      >
        <span data-testid="folder-children" />
      </FolderSection>
    );
  }

  test('展开态：chevron 旋转、aria-expanded 为真、计数可见', () => {
    const html = renderSection();
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('rotate-90');
    expect(html).toContain('data-testid="device-folder-count-a"');
    expect(html).toContain('data-testid="folder-children"');
  });

  test('重命名态：名称换成就地输入框，折叠按钮与菜单让位', () => {
    const html = renderSection({ renaming: true });
    expect(html).toContain('data-testid="device-folder-rename-input"');
    expect(html).toContain(i18n.t('devices.folders.namePlaceholder'));
    expect(html).not.toContain('data-testid="device-folder-toggle-a"');
    expect(html).not.toContain('data-testid="device-folder-menu-a"');
  });

  test('拖拽命中时整个分组标出 data-drop-target', () => {
    expect(renderSection()).not.toContain('data-drop-target="true"');
    expect(renderSection({ dropTarget: true })).toContain('data-drop-target="true"');
  });
});

describe('FolderNameEditor', () => {
  test('新建行带 device-folder-new 的 testid 与占位文案', () => {
    const html = renderMarkup(
      <FolderNameEditor
        testId="device-folder-new"
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />
    );
    expect(html).toContain('data-testid="device-folder-new"');
    expect(html).toContain(i18n.t('devices.folders.namePlaceholder'));
    expect(html).not.toContain('data-testid="device-folder-new-error"');
  });

  test('重命名时用现有名字预填', () => {
    const html = renderMarkup(
      <FolderNameEditor
        testId="device-folder-rename-input"
        initialName="书房"
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />
    );
    expect(html).toContain('书房');
  });
});
