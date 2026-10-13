// 一个标签页的文件浏览器：工具条 + 内容区（列表 / 图标视图或状态占位）+ 状态栏，
// 外加只挂一份的右键菜单、删除确认、快捷键面板与上传用的隐藏 input。必须挂在该节点的运行时之下。

import type { FileRootDto } from '@vibeterm/shared';
import { cn } from '@vibeterm/ui';
import type { HTMLAttributes, ReactNode, RefObject } from 'react';
import { useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { FileDeleteDialog } from '../files/ops/file-delete-dialog';
import { ExplorerContextMenu } from './actions';
import type { ExplorerBrowserProps, ExplorerNavDirection } from './browser-types';
import { ExplorerShortcutsDialog, ExplorerStatusBar, ExplorerToolbar } from './chrome';
import { ExplorerContentState } from './explorer-content-state';
import { destDisplayName } from './explorer-derive';
import { useBrowserFocus, useRowFlash } from './use-browser-focus';
import { type ExplorerController, useExplorerController } from './use-explorer-controller';
import { useExplorerRoots } from './use-explorer-data';
import type { ExplorerDropState } from './use-explorer-drop';
import { useExplorerKeyboard } from './use-explorer-keyboard';
import { ExplorerGridView, ExplorerListView, type ExplorerViewProps } from './views';

const ROOT_CLASS = 'flex h-full min-h-0 flex-col bg-background outline-none';
// 视图容器自己滚动，内容区只负责给它一个有界的高度
const CONTENT_CLASS = 'relative min-h-0 flex-1 overflow-hidden';
const ENTER_WRAPPER_CLASS = 'flex h-full min-h-0 flex-col';

const ENTER_CLASSES: Record<ExplorerNavDirection, string> = {
  forward: 'vibeterm-explorer-enter-forward',
  back: 'vibeterm-explorer-enter-back',
  up: 'vibeterm-explorer-enter-back',
  none: 'vibeterm-explorer-enter-fade',
};

/**
 * 入场动画类：换位置时按导航方向取；位置没变只换了视图模式时用淡入
 * （此时 navDirection 还是上一次导航留下的，不能照用）。
 */
function useEnterClass(location: string, viewMode: string, direction: ExplorerNavDirection) {
  const last = useRef({ location, viewMode, enterClass: ENTER_CLASSES[direction] });
  if (last.current.location !== location) {
    last.current = { location, viewMode, enterClass: ENTER_CLASSES[direction] };
  } else if (last.current.viewMode !== viewMode) {
    last.current = { location, viewMode, enterClass: ENTER_CLASSES.none };
  }
  return last.current.enterClass;
}

function DropOverlay({ drop, root }: { drop: ExplorerDropState; root: FileRootDto }) {
  const { t } = useTranslation();
  return (
    <>
      <div
        aria-hidden
        data-testid="explorer-drop-ring"
        className="vibeterm-explorer-drop pointer-events-none absolute inset-0 z-20 ring-1 ring-inset ring-primary/40"
      />
      <div
        data-testid="explorer-drop-pill"
        className="pointer-events-none absolute bottom-3 left-1/2 z-20 max-w-[80%] -translate-x-1/2 truncate rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground shadow-md"
      >
        {t(`explorer.drop.${drop.action}`, { name: destDisplayName(drop.destDir, root) })}
      </div>
    </>
  );
}

function viewPropsOf(props: ExplorerBrowserProps, c: ExplorerController): ExplorerViewProps {
  const { dialogs, drop, ops } = c;
  return {
    entries: c.entries,
    selection: c.selection.selection,
    cutPaths: c.cutPaths,
    renamingPath: dialogs.renamingPath,
    pendingFolder: dialogs.pendingFolder,
    sort: props.sort,
    dropTargetPath: drop.drop?.targetPath ?? null,
    coarsePointer: c.coarsePointer,
    onSortChange: props.onSortChange,
    onSelectionChange: c.selection.setSelection,
    onOpen: ops.open,
    onContextMenu: c.openContextMenu,
    onRenameCommit: ops.commitRename,
    onRenameCancel: () => dialogs.setRenamingPath(null),
    onPendingFolderCommit: ops.commitNewFolder,
    onPendingFolderCancel: () => dialogs.setPendingFolder(null),
    onItemDragStart: drop.onItemDragStart,
    onItemDragEnd: drop.onItemDragEnd,
    onDragOverTarget: drop.onDragOverTarget,
    onDropTarget: drop.onDropTarget,
    onDragLeaveAll: drop.onDragLeaveAll,
  };
}

interface BodyProps {
  props: ExplorerBrowserProps;
  root: FileRootDto;
  c: ExplorerController;
}

function ExplorerContent({ props, root, c }: BodyProps) {
  const { rootId, path, viewMode } = props;
  const enterClass = useEnterClass(`${rootId}\n${path}`, viewMode, props.navDirection);
  const { drop, backgroundHandlers } = c.drop;
  const View = viewMode === 'grid' ? ExplorerGridView : ExplorerListView;
  const stateAreaProps: HTMLAttributes<HTMLDivElement> = {
    ...backgroundHandlers,
    onContextMenu: (event) => c.openContextMenu(null, event),
  };
  return (
    <div data-testid="explorer-content" className={CONTENT_CLASS}>
      {c.contentKind === 'view' ? (
        <div key={`${rootId}:${path}:${viewMode}`} className={cn(ENTER_WRAPPER_CLASS, enterClass)}>
          <View {...viewPropsOf(props, c)} />
        </div>
      ) : (
        <ExplorerContentState
          kind={c.contentKind}
          errorCode={c.errorCode}
          onRetry={c.refresh}
          areaProps={stateAreaProps}
        />
      )}
      {drop && drop.targetPath === null && <DropOverlay drop={drop} root={root} />}
    </div>
  );
}

interface ChromeProps extends BodyProps {
  roots: readonly FileRootDto[];
}

function ExplorerChromeTop({ props, root, roots, c }: ChromeProps) {
  const { commands } = c;
  return (
    <ExplorerToolbar
      canBack={props.canBack}
      canForward={props.canForward}
      canUp={c.canUp}
      busy={c.busy}
      rootPath={root.path}
      rootName={root.name}
      path={props.path}
      roots={roots}
      rootId={props.rootId}
      viewMode={props.viewMode}
      showHidden={props.showHidden}
      query={c.query}
      filterInputRef={c.filterInputRef}
      onBack={props.onBack}
      onForward={props.onForward}
      onUp={() => props.onUp(root.path)}
      onRefresh={c.refresh}
      onNavigate={props.onNavigate}
      onSwitchRoot={(nextId) => {
        const next = roots.find((item) => item.id === nextId);
        if (next) props.onSwitchRoot(next.id, next.path);
      }}
      onNewFolder={() => commands.run('newFolder')}
      onUpload={() => commands.run('upload')}
      onViewModeChange={props.onViewModeChange}
      onShowHiddenChange={props.onShowHiddenChange}
      onQueryChange={c.setQuery}
      onShowShortcuts={() => commands.run('showShortcuts')}
      onDropOnCrumb={c.drop.onDropOnCrumb}
    />
  );
}

/** 只挂一份的浮层：右键菜单、删除确认、快捷键面板、上传用的隐藏 input。 */
function ExplorerOverlays({ c }: { c: ExplorerController }) {
  const { dialogs, commands } = c;
  const targets = dialogs.deleteTargets;
  // 关闭动画期间沿用上一份名称，标题不会先跳成「0 个项目」
  const lastNames = useRef<string[]>([]);
  const names = useMemo(() => targets?.map((entry) => entry.name) ?? null, [targets]);
  if (names) lastNames.current = names;
  return (
    <>
      <ExplorerContextMenu
        anchor={dialogs.menu.anchor}
        target={dialogs.menu.target}
        canPaste={c.canPaste}
        onCommand={commands.runFromMenu}
        onClose={dialogs.closeMenu}
      />
      <FileDeleteDialog
        open={targets !== null}
        names={lastNames.current}
        onConfirm={c.ops.confirmDelete}
        onClose={() => dialogs.setDeleteTargets(null)}
      />
      <ExplorerShortcutsDialog
        open={dialogs.shortcutsOpen}
        onClose={() => dialogs.setShortcutsOpen(false)}
      />
      {c.actions.fileInputs}
      {c.actions.dialogs}
    </>
  );
}

function ExplorerBrowserBody({ props, root, roots }: Omit<ChromeProps, 'c'>) {
  const c = useExplorerController(props, root);
  const { rootRef, dialogs } = c;
  const { active, rootId, path, viewMode } = props;

  useExplorerKeyboard({
    rootRef,
    active,
    suspended: dialogs.overlayOpen,
    run: c.commands.run,
  });
  const focus = useBrowserFocus({
    rootRef,
    active,
    suspended: dialogs.overlayOpen,
    contentKey: `${rootId}\n${path}\n${viewMode}\n${c.contentKind}`,
    entries: c.entries,
  });
  const { flashPath } = dialogs;
  useRowFlash(rootRef, flashPath, flashPath !== null && c.selection.selection.focus === flashPath);

  return (
    <BrowserRoot rootRef={rootRef} onActivate={props.onActivate} onBlur={focus.onBlur}>
      <ExplorerChromeTop props={props} root={root} roots={roots} c={c} />
      <ExplorerContent props={props} root={root} c={c} />
      <ExplorerStatusBar {...c.status} />
      <ExplorerOverlays c={c} />
    </BrowserRoot>
  );
}

function BrowserRoot({
  rootRef,
  onActivate,
  onBlur,
  children,
}: {
  rootRef?: RefObject<HTMLDivElement | null>;
  onActivate(): void;
  onBlur?: HTMLAttributes<HTMLDivElement>['onBlur'];
  children: ReactNode;
}) {
  return (
    <div
      ref={rootRef}
      // 可编程聚焦：视图不在时（空目录等）由根元素接住焦点，快捷键仍然有效
      tabIndex={-1}
      data-testid="explorer-browser"
      className={ROOT_CLASS}
      onPointerDownCapture={() => onActivate()}
      onBlur={onBlur}
    >
      {children}
    </div>
  );
}

export function ExplorerBrowser(props: ExplorerBrowserProps) {
  const rootsState = useExplorerRoots(props.rootId, props.onRootMissing);
  if (rootsState.root) {
    return <ExplorerBrowserBody props={props} root={rootsState.root} roots={rootsState.roots} />;
  }
  // 根还没解析出来：文件动作需要真实的 root，先只渲染占位状态
  const kind = rootsState.status === 'missing' ? 'rootMissing' : rootsState.status;
  return (
    <BrowserRoot onActivate={props.onActivate}>
      <ExplorerContentState
        kind={kind === 'ready' ? 'loading' : kind}
        errorCode={rootsState.errorCode}
        onRetry={rootsState.retry}
      />
    </BrowserRoot>
  );
}
