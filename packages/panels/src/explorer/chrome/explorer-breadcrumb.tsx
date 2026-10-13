// 地址栏：面包屑（溢出时中段折叠）与可编辑路径输入之间切换；每一级同时是拖放目标。

import type { FileRootDto } from '@vibeterm/shared';
import { ChevronRight, Pencil } from 'lucide-react';
import {
  type DragEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  BreadcrumbPathInput,
  HiddenCrumbsMenu,
  RootSwitcher,
  crumbClass,
} from './breadcrumb-parts';
import { type ExplorerCrumb, collapseCrumbs, explorerCrumbs } from './crumb-model';

export { collapseCrumbs, explorerCrumbs, resolveTypedPath } from './crumb-model';
export type { CollapsedCrumbs, ExplorerCrumb } from './crumb-model';

export interface ExplorerBreadcrumbProps {
  rootPath: string;
  rootName: string;
  path: string;
  onNavigate(path: string): void;
  onDropOnCrumb?(path: string, event: DragEvent): void;
  /** 传入多于一个根且给了 `onSwitchRoot` 时，根这一级变成切换下拉 */
  roots?: readonly FileRootDto[];
  rootId?: string;
  onSwitchRoot?(rootId: string): void;
}

interface CrumbFit {
  key: string;
  width: number;
  max: number;
}

/**
 * 量出放得下几级：每次渲染后看列表是否溢出，溢出就少显示一级再量（绘制前同步收敛）；
 * 容器宽度或路径变化时从「全部显示」重新开始。观察的是不随内容伸缩的外层容器，避免自激。
 */
function useCrumbFit(count: number, resetKey: string) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLElement | null>(null);
  const [fit, setFit] = useState<CrumbFit>({ key: resetKey, width: -1, max: count });
  const max = fit.key === resetKey ? Math.min(fit.max, count) : count;

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || max <= 2) return;
    if (list.scrollWidth <= list.clientWidth + 1) return;
    setFit({ key: resetKey, width: containerRef.current?.clientWidth ?? -1, max: max - 1 });
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const width = container.clientWidth;
      setFit((prev) =>
        prev.width === width && prev.key === resetKey ? prev : { key: resetKey, width, max: count }
      );
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [count, resetKey]);

  return { containerRef, listRef, max };
}

function useCrumbDrop(path: string, onDropOnCrumb?: (path: string, event: DragEvent) => void) {
  const [over, setOver] = useState(false);
  if (!onDropOnCrumb) return { over: false, handlers: {} };
  return {
    over,
    handlers: {
      onDragOver: (event: DragEvent) => {
        event.preventDefault();
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (event: DragEvent) => {
        event.preventDefault();
        setOver(false);
        onDropOnCrumb(path, event);
      },
    },
  };
}

interface CrumbProps {
  crumb: ExplorerCrumb;
  index: number;
  tight: boolean;
  onNavigate(path: string): void;
  onDropOnCrumb?(path: string, event: DragEvent): void;
}

function CrumbButton({ crumb, index, tight, onNavigate, onDropOnCrumb }: CrumbProps) {
  const { over, handlers } = useCrumbDrop(crumb.path, onDropOnCrumb);
  return (
    <button
      type="button"
      data-testid={`explorer-crumb-${index}`}
      data-drop-over={over || undefined}
      className={crumbClass({ current: false, interactive: true, tight, dropOver: over })}
      onClick={() => onNavigate(crumb.path)}
      {...handlers}
    >
      <span className="truncate">{crumb.label}</span>
    </button>
  );
}

function CurrentCrumb({ crumb, index, tight }: Pick<CrumbProps, 'crumb' | 'index' | 'tight'>) {
  return (
    <span
      data-testid={`explorer-crumb-${index}`}
      aria-current="location"
      className={crumbClass({ current: true, interactive: false, tight })}
    >
      <span className="truncate">{crumb.label}</span>
    </span>
  );
}

function RootDropZone({
  path,
  onDropOnCrumb,
  children,
}: {
  path: string;
  onDropOnCrumb?: (path: string, event: DragEvent) => void;
  children(over: boolean): ReactNode;
}) {
  const { over, handlers } = useCrumbDrop(path, onDropOnCrumb);
  return (
    <span className="inline-flex min-w-0" {...handlers}>
      {children(over)}
    </span>
  );
}

type TrailItem =
  | { kind: 'crumb'; crumb: ExplorerCrumb; index: number }
  | { kind: 'hidden'; crumbs: ExplorerCrumb[] };

function buildTrail(crumbs: readonly ExplorerCrumb[], max: number): TrailItem[] {
  const { head, hidden, tail } = collapseCrumbs(crumbs, max);
  const items: TrailItem[] = head.map((crumb, index) => ({ kind: 'crumb', crumb, index }));
  if (hidden.length > 0) items.push({ kind: 'hidden', crumbs: hidden });
  const tailStart = crumbs.length - tail.length;
  tail.forEach((crumb, offset) => {
    items.push({ kind: 'crumb', crumb, index: tailStart + offset });
  });
  return items;
}

interface TrailProps extends ExplorerBreadcrumbProps {
  items: TrailItem[];
  lastIndex: number;
  tight: boolean;
}

type CrumbItem = Extract<TrailItem, { kind: 'crumb' }>;

function TrailCrumb({ item, props }: { item: CrumbItem; props: TrailProps }) {
  const { crumb, index } = item;
  const { roots, rootId, onSwitchRoot, onNavigate, onDropOnCrumb, tight, lastIndex } = props;
  const current = index === lastIndex;
  if (index === 0 && roots && roots.length > 1 && onSwitchRoot) {
    const select = (id: string) => (id === rootId ? onNavigate(crumb.path) : onSwitchRoot(id));
    return (
      <RootDropZone path={crumb.path} onDropOnCrumb={current ? undefined : onDropOnCrumb}>
        {(over) => (
          <RootSwitcher
            roots={roots}
            rootId={rootId ?? ''}
            rootName={crumb.label}
            testId="explorer-crumb-0"
            className={crumbClass({ current, interactive: true, tight, dropOver: over })}
            onSelect={select}
          />
        )}
      </RootDropZone>
    );
  }
  if (current) return <CurrentCrumb crumb={crumb} index={index} tight={tight} />;
  return (
    <CrumbButton
      crumb={crumb}
      index={index}
      tight={tight}
      onNavigate={onNavigate}
      onDropOnCrumb={onDropOnCrumb}
    />
  );
}

function CrumbTrail(props: TrailProps) {
  return (
    <>
      {props.items.map((item, position) => (
        <span
          key={item.kind === 'crumb' ? item.crumb.path : 'hidden'}
          className={
            item.kind === 'crumb' && props.tight
              ? 'flex min-w-0 items-center'
              : 'flex shrink-0 items-center'
          }
        >
          {position > 0 && (
            <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground/60" />
          )}
          {item.kind === 'hidden' ? (
            <HiddenCrumbsMenu crumbs={item.crumbs} onNavigate={props.onNavigate} />
          ) : (
            <TrailCrumb item={item} props={props} />
          )}
        </span>
      ))}
    </>
  );
}

export function ExplorerBreadcrumb(props: ExplorerBreadcrumbProps) {
  const { rootPath, rootName, path, onNavigate } = props;
  const { t } = useTranslation();
  const crumbs = useMemo(
    () => explorerCrumbs(rootPath, rootName, path),
    [rootPath, rootName, path]
  );
  const { containerRef, listRef, max } = useCrumbFit(crumbs.length, `${rootPath}\n${path}`);
  const [editing, setEditing] = useState(false);
  const editButtonRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef(false);

  useEffect(() => {
    if (editing || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    editButtonRef.current?.focus();
  }, [editing]);

  const closeEdit = (restoreFocus: boolean) => {
    if (restoreFocus) restoreFocusRef.current = true;
    setEditing(false);
  };

  return (
    <div
      ref={containerRef}
      data-testid="explorer-breadcrumb"
      data-editing={editing || undefined}
      className="flex h-7 min-w-0 flex-1 items-center"
    >
      {editing ? (
        <BreadcrumbPathInput
          rootPath={rootPath}
          path={path}
          onNavigate={onNavigate}
          onClose={closeEdit}
        />
      ) : (
        <>
          <nav ref={listRef} className="flex min-w-0 items-center overflow-hidden p-0.5">
            <CrumbTrail
              {...props}
              items={buildTrail(crumbs, max)}
              lastIndex={crumbs.length - 1}
              tight={max <= 2}
            />
          </nav>
          <button
            ref={editButtonRef}
            type="button"
            data-testid="explorer-path-edit"
            aria-label={t('explorer.toolbar.editPath')}
            title={t('explorer.toolbar.editPath')}
            className="group/edit flex h-7 min-w-6 flex-1 cursor-text items-center rounded-md px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            onClick={() => setEditing(true)}
          >
            <Pencil
              aria-hidden
              className="size-3 text-muted-foreground opacity-0 transition-opacity duration-(--vibeterm-motion-fast) ease-out motion-reduce:transition-none group-hover/edit:opacity-60 group-focus-visible/edit:opacity-60"
            />
          </button>
        </>
      )}
    </div>
  );
}
