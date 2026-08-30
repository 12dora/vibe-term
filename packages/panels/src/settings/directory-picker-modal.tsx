// 图形化目录选择器：在指定设备上浏览任意目录（不受 file roots 白名单约束），
// 选中后把绝对路径回填给调用方（文件根表单的路径输入框）。
//
// 无 DOM 的单测环境下交互无法点击，所以状态迁移全部收敛到 `directoryPickerReducer`，
// 列表渲染拆成纯展示组件 `DirectoryEntryList`，两者都在 directory-picker-modal.test.tsx 里覆盖。

import { useQuery } from '@tanstack/react-query';
import type { BrowseDirectoryEntryDto } from '@tmex/shared';
import { ArrowUp, ChevronRight, Folder, Link2, TriangleAlert } from 'lucide-react';
import { type KeyboardEvent, useEffect, useReducer, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import type { ApiClient } from '@tmex/api-client';
import { browseDirectory } from '@tmex/api-client/file-resources';
import { useRuntime } from '@tmex/stores/react';
import { cn } from '@tmex/ui';
import { Button } from '@tmex/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tmex/ui/dialog';
import { Input } from '@tmex/ui/input';
import { ScrollArea } from '@tmex/ui/scroll-area';
import { Skeleton } from '@tmex/ui/skeleton';
import { Switch } from '@tmex/ui/switch';

export const DIRECTORY_BROWSE_QUERY_KEY = 'directory-browse';

export interface DirectoryBrowseQueryParams {
  deviceId: string;
  /** 空串表示从设备默认目录开始 */
  path: string;
  hidden: boolean;
  client: ApiClient;
}

export function directoryBrowseQueryOptions({
  deviceId,
  path,
  hidden,
  client,
}: DirectoryBrowseQueryParams) {
  return {
    queryKey: [DIRECTORY_BROWSE_QUERY_KEY, deviceId, path, hidden] as const,
    queryFn: () => browseDirectory({ deviceId, path: path || undefined, hidden }, client),
  };
}

/** 输入框里已是绝对路径就从那里打开，否则交给后端用设备默认目录。 */
export function resolvePickerInitialPath(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  return trimmed.startsWith('/') ? trimmed : '';
}

export interface DirectoryBreadcrumb {
  label: string;
  path: string;
}

/** `/a/b` → 根 + 每一级；非绝对路径（设备默认目录未知）没有面包屑。 */
export function directoryBreadcrumbs(path: string): DirectoryBreadcrumb[] {
  if (!path.startsWith('/')) return [];
  const crumbs: DirectoryBreadcrumb[] = [{ label: '/', path: '/' }];
  let acc = '';
  for (const segment of path.split('/').filter(Boolean)) {
    acc += `/${segment}`;
    crumbs.push({ label: segment, path: acc });
  }
  return crumbs;
}

/** 键盘上下移动高亮；-1 表示未高亮，越界按边界夹紧。 */
export function moveDirectoryHighlight(count: number, current: number, delta: number): number {
  if (count <= 0) return -1;
  const next = current + delta;
  if (next < 0) return 0;
  return next > count - 1 ? count - 1 : next;
}

export interface DirectoryPickerState {
  /** 请求目标路径；空串表示设备默认目录 */
  path: string;
  hidden: boolean;
  /** 可编辑路径输入框的当前值 */
  draft: string;
  /** 高亮条目下标，-1 表示未高亮（此时确认按钮选中当前目录） */
  highlight: number;
}

export type DirectoryPickerAction =
  | { type: 'reset'; path: string }
  | { type: 'navigate'; path: string }
  | { type: 'draft'; value: string }
  | { type: 'submitDraft' }
  | { type: 'toggleHidden'; hidden: boolean }
  | { type: 'highlight'; index: number }
  | { type: 'move'; delta: number; count: number }
  | { type: 'sync'; path: string };

export function createDirectoryPickerState(path: string): DirectoryPickerState {
  return { path, hidden: false, draft: path, highlight: -1 };
}

export function directoryPickerReducer(
  state: DirectoryPickerState,
  action: DirectoryPickerAction
): DirectoryPickerState {
  switch (action.type) {
    case 'reset':
      return createDirectoryPickerState(action.path);
    case 'navigate':
      return { ...state, path: action.path, draft: action.path, highlight: -1 };
    case 'draft':
      return { ...state, draft: action.value };
    case 'submitDraft': {
      const next = state.draft.trim();
      if (!next.startsWith('/')) return state;
      return { ...state, path: next, draft: next, highlight: -1 };
    }
    case 'toggleHidden':
      return { ...state, hidden: action.hidden, highlight: -1 };
    case 'highlight':
      return { ...state, highlight: action.index };
    case 'move':
      return {
        ...state,
        highlight: moveDirectoryHighlight(action.count, state.highlight, action.delta),
      };
    case 'sync':
      return state.draft === action.path ? state : { ...state, draft: action.path };
  }
}

/** 确认按钮落到哪个目录：高亮了子目录就取它，否则取当前所在目录。 */
export function resolvePickerSelection(
  entries: BrowseDirectoryEntryDto[],
  highlight: number,
  currentPath: string
): string {
  const entry = highlight >= 0 ? entries[highlight] : undefined;
  return entry?.path ?? currentPath;
}

export interface DirectoryEntryListProps {
  entries: BrowseDirectoryEntryDto[];
  highlight: number;
  onHighlight: (index: number) => void;
  onEnter: (path: string) => void;
}

export function DirectoryEntryList({
  entries,
  highlight,
  onHighlight,
  onEnter,
}: DirectoryEntryListProps) {
  const { t } = useTranslation();
  if (entries.length === 0) {
    return (
      <div
        className="py-8 text-center text-sm text-muted-foreground"
        data-testid="directory-picker-empty"
      >
        {t('settings.files.pickerEmpty')}
      </div>
    );
  }
  return (
    <div className="space-y-0.5 p-1" data-testid="directory-picker-list">
      {entries.map((entry, index) => (
        <button
          key={entry.path}
          type="button"
          data-picker-index={index}
          data-testid={`directory-picker-entry-${entry.name}`}
          aria-current={index === highlight ? 'true' : undefined}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none',
            index === highlight ? 'bg-muted' : 'hover:bg-muted/60',
            entry.hidden && 'text-muted-foreground'
          )}
          onClick={() => onHighlight(index)}
          onDoubleClick={() => onEnter(entry.path)}
        >
          <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-xs">{entry.name}</span>
          {entry.symlink && (
            <Link2
              className="h-3 w-3 shrink-0 text-muted-foreground"
              aria-label={t('settings.files.pickerSymlink')}
            />
          )}
        </button>
      ))}
    </div>
  );
}

function DirectoryBreadcrumbBar({
  path,
  onNavigate,
}: {
  path: string;
  onNavigate: (path: string) => void;
}) {
  const crumbs = directoryBreadcrumbs(path);
  if (crumbs.length === 0) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-0.5 text-xs text-muted-foreground"
      data-testid="directory-picker-breadcrumb"
    >
      {crumbs.map((crumb, index) => (
        <span key={crumb.path} className="flex items-center gap-0.5">
          {index > 0 && <ChevronRight className="h-3 w-3 shrink-0" />}
          <button
            type="button"
            className="max-w-40 truncate rounded px-1 py-0.5 font-mono hover:bg-muted hover:text-foreground"
            onClick={() => onNavigate(crumb.path)}
          >
            {crumb.label}
          </button>
        </span>
      ))}
    </div>
  );
}

function DirectoryPickerError({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex flex-col items-center gap-2 py-8 text-center"
      data-testid="directory-picker-error"
    >
      <span className="flex items-center gap-1.5 text-sm text-destructive">
        <TriangleAlert className="h-4 w-4 shrink-0" />
        {t('settings.files.pickerFailed')}
      </span>
      <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
        {t('common.retry')}
      </Button>
    </div>
  );
}

function DirectoryPickerSkeleton() {
  return (
    <div className="space-y-2 p-2" data-testid="directory-picker-loading">
      {[0, 1, 2, 3, 4].map((row) => (
        <Skeleton key={row} className="h-6 w-full" />
      ))}
    </div>
  );
}

export interface DirectoryPickerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deviceId: string;
  /** 打开时的初始路径；非绝对路径则从设备默认目录开始 */
  initialPath?: string;
  /** 设备所在 gateway 的 client；缺省用当前 runtime 的 */
  client?: ApiClient;
  onSelect: (path: string) => void;
}

export function DirectoryPickerModal({
  open,
  onOpenChange,
  deviceId,
  initialPath,
  client,
  onSelect,
}: DirectoryPickerModalProps) {
  const { t } = useTranslation();
  const { apiClient } = useRuntime();
  const browseClient = client ?? apiClient;

  const [state, dispatch] = useReducer(
    directoryPickerReducer,
    resolvePickerInitialPath(initialPath),
    createDirectoryPickerState
  );

  useEffect(() => {
    if (!open) return;
    dispatch({ type: 'reset', path: resolvePickerInitialPath(initialPath) });
  }, [open, initialPath]);

  const query = useQuery({
    ...directoryBrowseQueryOptions({
      deviceId,
      path: state.path,
      hidden: state.hidden,
      client: browseClient,
    }),
    enabled: open && deviceId.length > 0,
    retry: false,
  });

  const data = query.data;
  const responsePath = data?.path;

  useEffect(() => {
    if (responsePath) dispatch({ type: 'sync', path: responsePath });
  }, [responsePath]);

  const entries = data?.entries ?? [];
  const currentPath = responsePath ?? state.path;
  const highlighted = state.highlight >= 0 ? entries[state.highlight] : undefined;
  const selectedPath = resolvePickerSelection(entries, state.highlight, currentPath);

  const navigate = (path: string) => dispatch({ type: 'navigate', path });

  // 高亮跟着焦点走：方向键改高亮后把焦点挪到对应条目，后续 Enter 才落在它身上。
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.highlight < 0) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-picker-index="${state.highlight}"]`)
      ?.focus();
  }, [state.highlight]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // 路径输入框里的上下键留给光标
      if (target.tagName === 'INPUT') return;
      event.preventDefault();
      dispatch({ type: 'move', delta: event.key === 'ArrowDown' ? 1 : -1, count: entries.length });
      return;
    }
    // Enter 只在条目上改写成「进入目录」，面包屑等按钮保持原生激活
    if (event.key === 'Enter' && highlighted && target.closest('[data-picker-index]')) {
      event.preventDefault();
      navigate(highlighted.path);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="directory-picker-modal">
        <DialogHeader>
          <DialogTitle>{t('settings.files.pickerTitle')}</DialogTitle>
          <DialogDescription>{t('settings.files.pickerDescription')}</DialogDescription>
        </DialogHeader>

        {/* 方向键在整个内容区处理：焦点未必落在列表里（刚开窗时在工具栏） */}
        <div className="space-y-2" onKeyDown={handleKeyDown}>
          <DirectoryBreadcrumbBar path={currentPath} onNavigate={navigate} />

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon-lg"
              title={t('settings.files.pickerUp')}
              aria-label={t('settings.files.pickerUp')}
              data-testid="directory-picker-up"
              disabled={!data?.parent}
              onClick={() => {
                if (data?.parent) navigate(data.parent);
              }}
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
            <Input
              data-testid="directory-picker-path-input"
              aria-label={t('settings.files.path')}
              className="h-9 font-mono"
              value={state.draft}
              placeholder={t('settings.files.pathPlaceholder')}
              onChange={(event) => dispatch({ type: 'draft', value: event.target.value })}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                dispatch({ type: 'submitDraft' });
              }}
            />
          </div>

          <ScrollArea className="h-64 rounded-lg border border-border">
            <div ref={listRef}>
              {query.isError ? (
                <DirectoryPickerError
                  onRetry={() => void query.refetch()}
                  retrying={query.isFetching}
                />
              ) : query.isPending ? (
                <DirectoryPickerSkeleton />
              ) : (
                <DirectoryEntryList
                  entries={entries}
                  highlight={state.highlight}
                  onHighlight={(index) => dispatch({ type: 'highlight', index })}
                  onEnter={navigate}
                />
              )}
            </div>
          </ScrollArea>

          {data?.truncated && (
            <p className="text-xs text-muted-foreground">{t('settings.files.pickerTruncated')}</p>
          )}

          <div className="flex items-center gap-2">
            <Switch
              checked={state.hidden}
              onCheckedChange={(checked) =>
                dispatch({ type: 'toggleHidden', hidden: Boolean(checked) })
              }
              data-testid="directory-picker-hidden-switch"
            />
            <span className="text-sm">{t('settings.files.pickerShowHidden')}</span>
          </div>
        </div>

        <DialogFooter className="sm:items-center sm:justify-between">
          <div className="min-w-0 text-xs text-muted-foreground">
            <span>{t('settings.files.pickerCurrent')}</span>
            <span className="ml-1 truncate font-mono" data-testid="directory-picker-selected">
              {selectedPath}
            </span>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="secondary"
              data-testid="directory-picker-confirm"
              disabled={!selectedPath.startsWith('/')}
              onClick={() => {
                onSelect(selectedPath);
                onOpenChange(false);
              }}
            >
              {t('settings.files.pickerConfirm')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
