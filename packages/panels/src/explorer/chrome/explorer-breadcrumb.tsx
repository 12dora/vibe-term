// 地址栏：面包屑（按量得宽度摆放，当前目录优先）与可编辑路径输入之间切换；每一级同时是拖放目标。

import type { FileRootDto } from '@vibeterm/shared';
import { ChevronRight, Pencil } from 'lucide-react';
import {
  type DragEvent,
  type ReactNode,
  type RefObject,
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
  type RootChoice,
  RootCrumbLabel,
  RootSwitcher,
  crumbClass,
  crumbWidthStyle,
} from './breadcrumb-parts';
import {
  type CrumbFit,
  DEFAULT_CRUMB_METRICS,
  type ExplorerCrumb,
  explorerCrumbs,
  fitCrumbs,
} from './crumb-model';

export { explorerCrumbs, fitCrumbs, resolveTypedPath } from './crumb-model';
export type { CrumbFit, CrumbFitMetrics, ExplorerCrumb } from './crumb-model';

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

type DropHandler = (path: string, event: DragEvent) => void;

// 面包屑以外被占掉的宽度：编辑入口的最小宽度（min-w-6）+ 列表两侧留给焦点环的内边距（p-0.5）
const RESERVED_WIDTH = 28;
// 带下拉箭头的根至少要留出「约 4 个字 + 箭头」
const SWITCHER_MIN_ROOT = 56;

const NO_WIDTHS: number[] = [];

interface MeasuredWidths {
  key: string;
  widths: number[];
}

/**
 * 量宽度：各级的自然宽度取自一层不可见的影子节点，只在路径变化时量一次；
 * 容器宽度由 ResizeObserver 跟踪。两者都只是 fitCrumbs 的输入，摆放本身不再反复试排。
 */
function useCrumbMeasure(count: number, measureKey: string) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const shadowRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [measured, setMeasured] = useState<MeasuredWidths>({ key: '', widths: [] });
  // 容器被隐藏（display: none）时量不到宽度，等它重新出现再量
  const measurable = containerWidth > 0;

  useLayoutEffect(() => {
    setContainerWidth(containerRef.current?.clientWidth ?? 0);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setContainerWidth(container.clientWidth));
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const shadow = shadowRef.current;
    if (!shadow || !measurable) return;
    const widths = Array.from(shadow.children, (child) =>
      Math.ceil(child.getBoundingClientRect().width)
    );
    setMeasured({ key: measureKey, widths });
  }, [measureKey, measurable]);

  const ready = measured.key === measureKey && measured.widths.length === count && measurable;
  return {
    containerRef,
    shadowRef,
    widths: ready ? measured.widths : NO_WIDTHS,
    available: Math.max(1, containerWidth - RESERVED_WIDTH),
  };
}

function useCrumbDrop(path: string, onDropOnCrumb?: DropHandler) {
  const [over, setOver] = useState(false);

  // 拖拽被取消（Esc）或在别处结束时收不到 dragleave，靠全局 dragend / drop 兜底清掉高亮
  useEffect(() => {
    if (!over) return;
    const clear = () => setOver(false);
    window.addEventListener('dragend', clear, true);
    window.addEventListener('drop', clear, true);
    return () => {
      window.removeEventListener('dragend', clear, true);
      window.removeEventListener('drop', clear, true);
    };
  }, [over]);

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
  maxWidth: number | null;
  onNavigate(path: string): void;
  onDropOnCrumb?: DropHandler;
}

function CrumbButton({ crumb, index, maxWidth, onNavigate, onDropOnCrumb }: CrumbProps) {
  const { over, handlers } = useCrumbDrop(crumb.path, onDropOnCrumb);
  return (
    <button
      type="button"
      data-testid={`explorer-crumb-${index}`}
      data-drop-over={over || undefined}
      className={crumbClass({ current: false, interactive: true, dropOver: over })}
      style={crumbWidthStyle(maxWidth)}
      onClick={() => onNavigate(crumb.path)}
      {...handlers}
    >
      <span className="truncate">{crumb.label}</span>
    </button>
  );
}

function CurrentCrumb({
  crumb,
  index,
  maxWidth,
}: Pick<CrumbProps, 'crumb' | 'index' | 'maxWidth'>) {
  return (
    <span
      data-testid={`explorer-crumb-${index}`}
      aria-current="location"
      title={crumb.label}
      className={crumbClass({ current: true, interactive: false })}
      style={crumbWidthStyle(maxWidth)}
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
  onDropOnCrumb?: DropHandler;
  children(over: boolean): ReactNode;
}) {
  const { over, handlers } = useCrumbDrop(path, onDropOnCrumb);
  return (
    <span className="inline-flex min-w-0" {...handlers}>
      {children(over)}
    </span>
  );
}

export type TrailItem =
  | { kind: 'crumb'; crumb: ExplorerCrumb; index: number }
  | { kind: 'hidden'; crumbs: ExplorerCrumb[] };

/** 摆放顺序：根（若仍可见）→「…」→ 其余可见级；根被收起时「…」排最前。 */
export function buildTrail(crumbs: readonly ExplorerCrumb[], fit: CrumbFit): TrailItem[] {
  const hidden = new Set(fit.hidden);
  const items: TrailItem[] = [];
  crumbs.forEach((crumb, index) => {
    if (!hidden.has(index)) items.push({ kind: 'crumb', crumb, index });
  });
  if (hidden.size > 0) {
    const collapsed = crumbs.filter((_, index) => hidden.has(index));
    items.splice(fit.rootVisible ? 1 : 0, 0, { kind: 'hidden', crumbs: collapsed });
  }
  return items;
}

interface TrailContext {
  fit: CrumbFit;
  lastIndex: number;
  rootChoice?: RootChoice;
  onNavigate(path: string): void;
  onDropOnCrumb?: DropHandler;
}

type CrumbItem = Extract<TrailItem, { kind: 'crumb' }>;

function crumbMaxWidth(index: number, context: TrailContext): number | null {
  if (index === context.lastIndex) return context.fit.lastMaxWidth;
  return index === 0 ? context.fit.rootMaxWidth : null;
}

function TrailCrumb({ item, context }: { item: CrumbItem; context: TrailContext }) {
  const { crumb, index } = item;
  const { rootChoice, onNavigate, onDropOnCrumb } = context;
  const current = index === context.lastIndex;
  const maxWidth = crumbMaxWidth(index, context);
  if (index === 0 && rootChoice) {
    return (
      <RootDropZone path={crumb.path} onDropOnCrumb={current ? undefined : onDropOnCrumb}>
        {(over) => (
          <RootSwitcher
            {...rootChoice}
            rootName={crumb.label}
            testId="explorer-crumb-0"
            className={crumbClass({ current, interactive: true, dropOver: over })}
            style={crumbWidthStyle(maxWidth)}
          />
        )}
      </RootDropZone>
    );
  }
  if (current) return <CurrentCrumb crumb={crumb} index={index} maxWidth={maxWidth} />;
  return (
    <CrumbButton
      crumb={crumb}
      index={index}
      maxWidth={maxWidth}
      onNavigate={onNavigate}
      onDropOnCrumb={onDropOnCrumb}
    />
  );
}

function HiddenItem({ crumbs, context }: { crumbs: ExplorerCrumb[]; context: TrailContext }) {
  // 根也被收起且可切换：菜单顶部换成根列表（当前根 = 回到根目录），其余是中间各级
  const rootChoice = context.fit.rootVisible ? undefined : context.rootChoice;
  return (
    <HiddenCrumbsMenu
      crumbs={rootChoice ? crumbs.slice(1) : crumbs}
      rootChoice={rootChoice}
      onNavigate={context.onNavigate}
    />
  );
}

function CrumbTrail({ items, context }: { items: TrailItem[]; context: TrailContext }) {
  return (
    <>
      {items.map((item, position) => (
        <span
          key={item.kind === 'crumb' ? item.crumb.path : 'hidden'}
          className="flex shrink-0 items-center"
        >
          {position > 0 && (
            <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground/60" />
          )}
          {item.kind === 'hidden' ? (
            <HiddenItem crumbs={item.crumbs} context={context} />
          ) : (
            <TrailCrumb item={item} context={context} />
          )}
        </span>
      ))}
    </>
  );
}

/** 不可见的影子节点：与真实面包屑同一套样式，各级按自然宽度排开，专供量宽度。 */
function CrumbShadow({
  crumbs,
  switchable,
  shadowRef,
}: {
  crumbs: readonly ExplorerCrumb[];
  switchable: boolean;
  shadowRef: RefObject<HTMLDivElement | null>;
}) {
  const lastIndex = crumbs.length - 1;
  return (
    <div
      ref={shadowRef}
      aria-hidden
      className="pointer-events-none invisible absolute top-0 left-0 flex h-0 overflow-hidden whitespace-nowrap"
    >
      {crumbs.map((crumb, index) => (
        <span
          key={crumb.path}
          className={crumbClass({ current: index === lastIndex, interactive: false })}
        >
          {index === 0 && switchable ? (
            <RootCrumbLabel rootName={crumb.label} />
          ) : (
            <span className="truncate">{crumb.label}</span>
          )}
        </span>
      ))}
    </div>
  );
}

function resolveRootChoice(
  props: ExplorerBreadcrumbProps,
  rootCrumbPath: string
): RootChoice | undefined {
  const { roots, rootId, onSwitchRoot, onNavigate } = props;
  if (!roots || roots.length <= 1 || !onSwitchRoot) return undefined;
  return {
    roots,
    rootId: rootId ?? '',
    onSelect: (id: string) => (id === rootId ? onNavigate(rootCrumbPath) : onSwitchRoot(id)),
  };
}

export function ExplorerBreadcrumb(props: ExplorerBreadcrumbProps) {
  const { rootPath, rootName, path, onNavigate, onDropOnCrumb } = props;
  const { t } = useTranslation();
  const crumbs = useMemo(
    () => explorerCrumbs(rootPath, rootName, path),
    [rootPath, rootName, path]
  );
  const rootChoice = resolveRootChoice(props, crumbs[0]?.path ?? rootPath);
  const switchable = rootChoice !== undefined;
  const { containerRef, shadowRef, widths, available } = useCrumbMeasure(
    crumbs.length,
    `${rootPath}\n${rootName}\n${path}\n${switchable}`
  );
  const fit = useMemo(
    () =>
      fitCrumbs(widths, widths.length > 0 ? available : 0, {
        ...DEFAULT_CRUMB_METRICS,
        minRoot: switchable ? SWITCHER_MIN_ROOT : DEFAULT_CRUMB_METRICS.minRoot,
      }),
    [widths, available, switchable]
  );
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
  const context = { fit, lastIndex: crumbs.length - 1, rootChoice, onNavigate, onDropOnCrumb };

  return (
    <div
      ref={containerRef}
      data-testid="explorer-breadcrumb"
      data-editing={editing || undefined}
      className="relative flex h-7 min-w-0 flex-1 items-center"
    >
      <CrumbShadow crumbs={crumbs} switchable={switchable} shadowRef={shadowRef} />
      {editing ? (
        <BreadcrumbPathInput
          rootPath={rootPath}
          path={path}
          onNavigate={onNavigate}
          onClose={closeEdit}
        />
      ) : (
        <>
          <nav className="flex min-w-0 items-center overflow-hidden p-0.5">
            <CrumbTrail items={buildTrail(crumbs, fit)} context={context} />
          </nav>
          <EditPathButton
            buttonRef={editButtonRef}
            label={t('explorer.toolbar.editPath')}
            onClick={() => setEditing(true)}
          />
        </>
      )}
    </div>
  );
}

function EditPathButton({
  buttonRef,
  label,
  onClick,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  label: string;
  onClick(): void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      data-testid="explorer-path-edit"
      aria-label={label}
      title={label}
      className="group/edit flex h-7 min-w-6 flex-1 cursor-text items-center rounded-md px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      onClick={onClick}
    >
      <Pencil
        aria-hidden
        className="size-3 text-muted-foreground opacity-0 transition-opacity duration-(--vibeterm-motion-fast) ease-out motion-reduce:transition-none group-hover/edit:opacity-60 group-focus-visible/edit:opacity-60"
      />
    </button>
  );
}
