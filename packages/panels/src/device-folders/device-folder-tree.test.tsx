// 无 DOM 环境，用 react-dom/server 静态渲染断言结构（与 device-card.test.tsx 同一套做法）。
// 交互态（重命名 / 新建行）由外部 props 驱动的 FolderSection / FolderNameEditor 直接覆盖。

import { describe, expect, test } from 'bun:test';
import type { DeviceFolder, DeviceFolderItemRef, DeviceFolderLayout } from '@tmex/shared';
import { renderToStaticMarkup } from 'react-dom/server';

import { DeviceFolderTree } from './device-folder-tree';
import { FolderNameEditor } from './folder-name-editor';
import { FolderSection } from './folder-section';

function folder(id: string, parentId: string | null, sortOrder: number): DeviceFolder {
  return {
    id,
    name: `folder-${id}`,
    parentId,
    sortOrder,
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
  };
}

function nodeItem(nodeId: string): DeviceFolderItemRef {
  return { kind: 'node', nodeId, deviceId: null };
}

function deviceItem(nodeId: string, deviceId: string): DeviceFolderItemRef {
  return { kind: 'device', nodeId, deviceId };
}

const LAYOUT: DeviceFolderLayout = {
  folders: [folder('a', null, 0), folder('b', null, 1), folder('a1', 'a', 0)],
  placements: [
    { ...deviceItem('self', 'd1'), folderId: 'a', sortOrder: 0 },
    { ...nodeItem('n1'), folderId: null, sortOrder: 0 },
  ],
};

function renderTree(
  overrides: Partial<React.ComponentProps<typeof DeviceFolderTree>> = {}
): string {
  return renderToStaticMarkup(
    <DeviceFolderTree
      layout={LAYOUT}
      implicitRootItems={[nodeItem('self')]}
      expanded={{}}
      itemLabel={(item) => `label:${item.nodeId}`}
      renderItem={(item) => <span data-testid={`rendered-${item.kind}-${item.nodeId}`} />}
      onExpandedChange={() => undefined}
      onDrop={() => undefined}
      onCreateFolder={() => undefined}
      onRenameFolder={() => undefined}
      onDeleteFolder={() => undefined}
      onMoveItemToRoot={() => undefined}
      {...overrides}
    />
  );
}

describe('DeviceFolderTree', () => {
  test('渲染文件夹层级、计数与条目外壳', () => {
    const html = renderTree();

    expect(html).toContain('data-testid="device-folder-tree"');
    expect(html).toContain('data-testid="device-folder-a"');
    expect(html).toContain('data-testid="device-folder-b"');
    expect(html).toContain('data-testid="device-folder-a1"');
    expect(html).toContain('data-testid="device-folder-toggle-a"');
    expect(html).toContain('data-testid="device-folder-name-a"');
    expect(html).toContain('data-testid="device-folder-menu-a"');
    // 条目外壳按 deviceFolderItemKey 命名
    expect(html).toContain('data-testid="device-folder-item-node:n1"');
    expect(html).toContain('data-testid="device-folder-item-node:self"');
    expect(html).toContain('data-testid="device-folder-item-device:self:d1"');
    expect(html).toContain('data-testid="rendered-device-self"');
  });

  test('缩进层级写在 data-depth 上，根文件夹为 0、子文件夹为 1', () => {
    const html = renderTree();
    const depthOf = (id: string) => {
      const marker = `data-testid="device-folder-${id}"`;
      const index = html.indexOf(marker);
      const tag = html.slice(html.lastIndexOf('<', index), html.indexOf('>', index));
      return tag.match(/data-depth="(\d+)"/)?.[1] ?? null;
    };
    expect(depthOf('a')).toBe('0');
    expect(depthOf('a1')).toBe('1');
  });

  test('隐式根条目排在显式 placement 之后', () => {
    const html = renderTree();
    expect(html.indexOf('data-testid="device-folder-item-node:n1"')).toBeLessThan(
      html.indexOf('data-testid="device-folder-item-node:self"')
    );
  });

  test('空文件夹渲染放置提示，非空的不渲染', () => {
    const html = renderTree();
    expect(html).toContain('data-testid="device-folder-drop-a1"');
    expect(html).toContain('data-testid="device-folder-drop-b"');
    expect(html).not.toContain('data-testid="device-folder-drop-a"');
  });

  test('itemDraggable 返回 false 的条目不套拖拽把手', () => {
    const html = renderTree({
      itemDraggable: (item) => !(item.kind === 'node' && item.nodeId === 'self'),
    });
    const index = html.indexOf('data-testid="device-folder-item-node:self"');
    const nextItem = html.indexOf('data-testid="device-folder-item-', index + 1);
    const slice = html.slice(index, nextItem === -1 ? undefined : nextItem);
    expect(slice).toContain('data-testid="rendered-node-self"');
    expect(slice).not.toContain('devices.folders.dragHandle');
  });

  test('初始就收起的文件夹不挂载内容（其中的落点与远端 runtime 随之释放），并标记 aria-hidden', () => {
    const html = renderTree({ expanded: { a: false } });
    const index = html.indexOf('data-testid="device-folder-a"');
    const tag = html.slice(html.lastIndexOf('<', index), html.indexOf('>', index));
    expect(tag).toContain('data-expanded="false"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('data-testid="device-folder-item-device:self:d1"');
  });

  test('没有文件夹也没有条目时只渲染空树容器', () => {
    const html = renderTree({
      layout: { folders: [], placements: [] },
      implicitRootItems: [],
    });
    expect(html).toContain('data-testid="device-folder-tree"');
    expect(html).not.toContain('data-testid="device-folder-item-');
  });
});

describe('FolderSection', () => {
  function renderSection(overrides: Partial<React.ComponentProps<typeof FolderSection>> = {}) {
    return renderToStaticMarkup(
      <FolderSection
        folder={folder('a', null, 0)}
        depth={0}
        itemCount={3}
        expanded={true}
        renaming={false}
        dragDisabled={false}
        dropTarget={false}
        onToggle={() => undefined}
        onStartRename={() => undefined}
        onSubmitRename={() => undefined}
        onCancelRename={() => undefined}
        onNewSubfolder={() => undefined}
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
    expect(html).toContain('devices.folders.namePlaceholder');
    expect(html).not.toContain('data-testid="device-folder-toggle-a"');
    expect(html).not.toContain('data-testid="device-folder-menu-a"');
  });

  test('拖拽命中时文件夹头标出 data-drop-target', () => {
    expect(renderSection()).not.toContain('data-drop-target="true"');
    expect(renderSection({ dropTarget: true })).toContain('data-drop-target="true"');
  });

  test('缩进封顶：超过 MAX_INDENT_DEPTH 的层级不再加竖线与内边距', () => {
    expect(renderSection({ depth: 3 })).toContain('border-l');
    const capped = renderSection({ depth: 9 });
    expect(capped).toContain('data-depth="6"');
    expect(capped).not.toContain('border-l');
  });
});

describe('FolderNameEditor', () => {
  test('新建行带 device-folder-new 的 testid 与占位文案', () => {
    const html = renderToStaticMarkup(
      <FolderNameEditor
        testId="device-folder-new"
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />
    );
    expect(html).toContain('data-testid="device-folder-new"');
    expect(html).toContain('devices.folders.namePlaceholder');
    expect(html).not.toContain('data-testid="device-folder-new-error"');
  });

  test('重命名时用现有名字预填', () => {
    const html = renderToStaticMarkup(
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
