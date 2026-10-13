// 无 DOM 环境，用 react-dom/server 静态渲染断言结构（与 device-card.test.tsx 同一套做法）。
// 交互态（重命名 / 新建行）由外部 props 驱动的 FolderSection / FolderNameEditor 直接覆盖。

import { describe, expect, test } from 'bun:test';
import { type DeviceFolder, type DeviceFolderLayout, I18N_RESOURCES } from '@vibeterm/shared';
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
import { placeholderMinHeight, previewOrderMap } from './node-list';
import { FREEZE_HEIGHT_ATTR } from './use-frozen-heights';
import { dragModeOf, reflowSignals } from './use-tree-drag';

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

describe('节点磁贴网格', () => {
  test('根层与每个非空分组各有一张节点网格（容器查询的宿主套在网格外面）', () => {
    const html = renderTree();
    // 分组 a（n1）+ 根层（n2、self）；分组 b 是空的
    expect(html.split('data-testid="devices-node-grid"').length - 1).toBe(2);
    expect(tagOf(html, 'data-testid="devices-node-grid"')).toContain('@container');
    const grid = html.slice(html.indexOf('data-testid="devices-node-grid"'));
    expect(grid.slice(0, grid.indexOf('data-testid="device-folder-item-node:n1"'))).toContain(
      '@[48rem]:grid-cols-2 @[80rem]:grid-cols-3'
    );
  });

  test('空分组的落点提示不进网格：整行宽，哪一列都接得住', () => {
    const html = renderTree();
    const emptyFolder = html.slice(
      html.indexOf('data-testid="device-folder-b"'),
      html.indexOf('data-testid="device-folder-drop-b"')
    );
    expect(emptyFolder).not.toContain('data-testid="devices-node-grid"');
  });

  test('没给 nodeSpan 时每个磁贴占一格', () => {
    const html = renderTree();
    for (const nodeId of ['n1', 'n2', 'self']) {
      const tag = tagOf(html, `data-testid="device-folder-item-node:${nodeId}"`);
      expect(tag).toContain('data-span="1"');
      expect(tag).toContain('col-span-1');
      expect(tag).not.toContain('col-span-2');
    }
  });

  test('nodeSpan 决定磁贴的 data-span 与跨度类；宿主拿得到节点所在的分组', () => {
    const seen: [string, string | null][] = [];
    const html = renderTree({
      nodeSpan: (nodeId, ctx) => {
        seen.push([nodeId, ctx.folderId]);
        if (nodeId === 'n1') return 2;
        return nodeId === 'n2' ? 3 : 'full';
      },
    });
    const n1 = tagOf(html, 'data-testid="device-folder-item-node:n1"');
    expect(n1).toContain('data-span="2"');
    expect(n1).toContain('@[48rem]:col-span-2');
    expect(n1).not.toContain('col-span-3');
    const n2 = tagOf(html, 'data-testid="device-folder-item-node:n2"');
    expect(n2).toContain('data-span="3"');
    expect(n2).toContain('@[48rem]:col-span-2 @[80rem]:col-span-3');
    const self = tagOf(html, 'data-testid="device-folder-item-node:self"');
    expect(self).toContain('data-span="full"');
    expect(self).toContain('col-span-full');
    expect(seen).toContainEqual(['n1', 'a']);
    expect(seen).toContainEqual(['n2', null]);
  });

  test('不套拖拽外壳的节点同样带跨度', () => {
    const html = renderTree({ nodeDraggable: () => false, nodeSpan: () => 2 });
    const tag = tagOf(html, 'data-testid="device-folder-item-node:self"');
    expect(tag).toContain('data-span="2"');
    expect(tag).toContain('@[48rem]:col-span-2');
  });

  test('没在拖拽时条目不带 order，占位条不渲染；条目带回流过渡用的 id', () => {
    const html = renderTree();
    const tag = tagOf(html, 'data-testid="device-folder-item-node:n2"');
    expect(tag).not.toContain('order:');
    expect(tag).toContain('data-flip-id="node:n2"');
    expect(html).not.toContain('data-testid="device-folder-drop-placeholder"');
    // 不套拖拽外壳的节点也参与回流过渡
    const plain = renderTree({ nodeDraggable: () => false });
    expect(tagOf(plain, 'data-testid="device-folder-item-node:self"')).toContain(
      'data-flip-id="node:self"'
    );
  });

  test('previewOrderMap：视觉顺序与 DOM 顺序一致时不给 order，否则下标即视觉位置', () => {
    const dom = ['node:a', 'node:b', 'node:c'];
    expect(previewOrderMap(dom, dom)).toBeNull();
    expect(previewOrderMap(dom, [...dom])).toBeNull();
    const moved = previewOrderMap(dom, ['node:b', 'node:c', 'node:a']);
    expect(moved?.get('node:a')).toBe(2);
    expect(moved?.get('node:b')).toBe(0);
    expect(moved?.get('node:c')).toBe(1);
    // 占位条排在 DOM 末尾，视觉位置由 order 决定
    const withPlaceholder = previewOrderMap(dom, ['node:a', '__placeholder__', 'node:b', 'node:c']);
    expect(withPlaceholder?.get('__placeholder__')).toBe(1);
    expect(withPlaceholder?.get('node:b')).toBe(2);
  });

  test('整棵树与每张节点网格都标了冻结高度的记号；网格是磁贴的 offsetParent 且多余高度留白', () => {
    const html = renderTree();
    expect(tagOf(html, 'data-testid="device-folder-tree"')).toContain(FREEZE_HEIGHT_ATTR);
    // 树根 + 分组 a 的网格 + 根层网格
    expect(html.split(`${FREEZE_HEIGHT_ATTR}=`).length - 1).toBe(3);
    const grid = html.slice(html.indexOf('data-testid="devices-node-grid"'));
    const inner = grid.slice(0, grid.indexOf('data-testid="device-folder-item-node:n1"'));
    expect(inner).toContain(FREEZE_HEIGHT_ATTR);
    expect(inner).toContain('relative grid');
    expect(inner).toContain('content-start');
  });

  test('reflowSignals：只在拖节点时给补量信号；拖分组 / 没在拖都是空串', () => {
    const idle = { activeId: null, placeholder: null, reorder: null };
    expect(reflowSignals(idle, { a: false })).toEqual({ reflow: '', expand: '' });
    // 拖分组用的是位移预览，落点矩形不该重量（否则带着位移的分组头会被量歪）
    const folderDrag = { ...idle, activeId: 'folder:a' };
    expect(reflowSignals(folderDrag, { a: false })).toEqual({ reflow: '', expand: '' });

    const nodeDrag = { ...idle, activeId: 'node:n1' };
    const before = reflowSignals(nodeDrag, { a: false });
    expect(before.reflow).not.toBe('');
    // 预览变了 → reflow 变；展开态没变 → expand 不变
    const reordered = reflowSignals(
      { ...nodeDrag, reorder: { containerId: 'root', elementId: 'node:n1', index: 1 } },
      { a: false }
    );
    expect(reordered.reflow).not.toBe(before.reflow);
    expect(reordered.expand).toBe(before.expand);
    // 展开态变了 → expand 变；预览没变 → reflow 不变
    const expanded = reflowSignals(nodeDrag, { a: true });
    expect(expanded.expand).not.toBe(before.expand);
    expect(expanded.reflow).toBe(before.reflow);
  });

  test('dragModeOf：只有键盘事件发起的拖拽算键盘模式', () => {
    expect(dragModeOf(null)).toBe('pointer');
    expect(dragModeOf(undefined)).toBe('pointer');
    expect(dragModeOf(new Event('pointerdown'))).toBe('pointer');
    if (typeof KeyboardEvent !== 'undefined') {
      expect(dragModeOf(new KeyboardEvent('keydown', { code: 'Space' }))).toBe('keyboard');
    }
  });

  test('占位条的高度不低于被拖磁贴量到的高度，量不到用兜底值', () => {
    expect(placeholderMinHeight(180)).toBe(180);
    expect(placeholderMinHeight(12)).toBe(48);
    expect(placeholderMinHeight(null)).toBe(48);
    expect(placeholderMinHeight(undefined)).toBe(48);
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
