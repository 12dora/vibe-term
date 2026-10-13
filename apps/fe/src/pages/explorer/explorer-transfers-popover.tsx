// 页头的「传输」按钮：角标是在跑的节点间任务数，点开是与设备页传输弹窗同一份任务列表。
// 按钮在文件管理器页面上常驻，所以任务同步与复制收尾的 watcher 也挂在这里。

import { type PopoverBox, placePopover } from '@/node/popover-clamp';
import {
  type TransferJobView,
  isTerminalTransferState,
  useTransferJobs,
} from '@vibeterm/panels/files/transfers';
import type { ExplorerTab } from '@vibeterm/stores';
import { useExplorerStore } from '@vibeterm/stores/explorer';

import { Button } from '@vibeterm/ui/button';
import { IconTooltip } from '@vibeterm/ui/icon-tooltip';
import { ArrowLeftRight } from 'lucide-react';
import {
  type CSSProperties,
  type ReactElement,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import type { DialogNodeOption } from '../devices/dialog-nodes';
import { TransferJobsList } from '../devices/transfer/transfer-list';
import { useTransferJobsSync } from '../devices/transfer/use-transfer-jobs-sync';
import { useExplorerNodes } from './explorer-nodes';
import {
  pendingExplorerTransferNodeKey,
  subscribeExplorerTransfers,
  useExplorerTransferWatch,
} from './use-explorer-transfer-watch';

/** 22rem */
export const TRANSFERS_POPOVER_WIDTH = 352;

/** 角标只数节点间任务：浏览器上传 / 下载自己有进度 Toast。 */
export function runningNodeJobCount(jobs: readonly TransferJobView[]): number {
  return jobs.filter((job) => job.kind === 'node' && !isTerminalTransferState(job.state)).length;
}

/** 打开着标签页的节点（去重、排序后拼成稳定的串，可直接当 zustand selector 的返回值）。 */
export function tabNodeKey(tabs: Record<string, ExplorerTab>): string {
  return [...new Set(Object.values(tabs).map((tab) => tab.nodeId))].sort().join(',');
}

export interface TransferSyncInput {
  /** `tabNodeKey` 的结果。 */
  tabNodeKey: string;
  jobs: readonly TransferJobView[];
  /** `pendingExplorerTransferNodeKey()` 的结果。 */
  pendingNodeKey: string;
  find: (nodeId: string) => DialogNodeOption | undefined;
}

/**
 * 要拉任务列表并续订进度的节点：开着标签页的 ∪ store 里未结束任务所在的源节点 ∪ 登记表里
 * 等着收尾的任务所在的源节点。后两项保证「源节点的标签页已经关了、离开页面又回来」时任务
 * 仍能续上（否则角标卡住、没有完成提示、登记项也不会被摘掉）。
 * 只向在线且已登录的节点要，其余的请求注定失败。
 */
export function transferSyncNodeIds(input: TransferSyncInput): string[] {
  const ids = new Set<string>([...input.tabNodeKey.split(','), ...input.pendingNodeKey.split(',')]);
  for (const job of input.jobs) {
    if (job.kind === 'node' && !isTerminalTransferState(job.state)) ids.add(job.nodeId);
  }
  return [...ids].filter((id) => id !== '' && input.find(id)?.usable === true).sort();
}

// 无 DOM（SSR / bun test）时降级成 useEffect，避免 React 的 useLayoutEffect 警告。
const useMeasureEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

function measure(anchor: DOMRect): PopoverBox {
  const visual = window.visualViewport;
  const root = document.documentElement;
  return placePopover({
    anchor,
    viewport: {
      width: visual?.width ?? root.clientWidth ?? window.innerWidth,
      height: visual?.height ?? window.innerHeight,
      offsetLeft: visual?.offsetLeft ?? 0,
      offsetTop: visual?.offsetTop ?? 0,
      layoutHeight: root.clientHeight || window.innerHeight,
    },
    maxWidth: TRANSFERS_POPOVER_WIDTH,
  });
}

// 页头祖先带 overflow，浮层必须 portal 到 body 用 fixed 定位；展开期间跟住按钮。
function usePanelPlacement(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean
): PopoverBox | null {
  const [placement, setPlacement] = useState<PopoverBox | null>(null);

  useMeasureEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (rect) setPlacement(measure(rect));
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, [open, anchorRef]);

  return placement;
}

function useDismiss(
  open: boolean,
  refs: ReadonlyArray<RefObject<HTMLElement | null>>,
  onDismiss: () => void
): void {
  const latest = useRef({ refs, onDismiss });
  useEffect(() => {
    latest.current = { refs, onDismiss };
  });

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: Event) => {
      const target = event.target as Node;
      if (latest.current.refs.some((ref) => ref.current?.contains(target))) return;
      latest.current.onDismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') latest.current.onDismiss();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);
}

function panelStyle(placement: PopoverBox): CSSProperties {
  return {
    left: `${placement.left}px`,
    ...(placement.top === null ? {} : { top: `${placement.top}px` }),
    ...(placement.bottom === null ? {} : { bottom: `${placement.bottom}px` }),
    width: `${placement.width}px`,
    maxHeight: `min(60vh, ${placement.maxHeight}px)`,
  };
}

export function ExplorerTransfersPanel({
  jobCount,
  options,
}: {
  jobCount: number;
  options: DialogNodeOption[];
}) {
  const { t } = useTranslation();
  if (jobCount === 0) {
    return (
      <p
        className="py-6 text-center text-xs text-muted-foreground"
        data-testid="explorer-transfers-empty"
      >
        {t('explorer.transfer.empty')}
      </p>
    );
  }
  return <TransferJobsList options={options} />;
}

function RunningBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span
      data-testid="explorer-transfers-count"
      className="vibeterm-scale-in pointer-events-none absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] leading-none font-medium text-primary-foreground tabular-nums"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

export function ExplorerTransfersButton(): ReactElement {
  const { t } = useTranslation();
  const { options, find } = useExplorerNodes();
  const jobs = useTransferJobs();
  const nodeKey = useExplorerStore((state) => tabNodeKey(state.tabs));
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const pendingNodeKey = useSyncExternalStore(
    subscribeExplorerTransfers,
    pendingExplorerTransferNodeKey,
    pendingExplorerTransferNodeKey
  );
  const nodeIds = useMemo(
    () => transferSyncNodeIds({ tabNodeKey: nodeKey, jobs, pendingNodeKey, find }),
    [nodeKey, jobs, pendingNodeKey, find]
  );
  useTransferJobsSync(true, nodeIds);
  useExplorerTransferWatch();

  const placement = usePanelPlacement(anchorRef, open);
  useDismiss(open, [anchorRef, panelRef], () => setOpen(false));

  const label = t('explorer.toolbar.transfers');

  return (
    <div ref={anchorRef} className="relative inline-flex">
      <IconTooltip label={label}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-testid="explorer-transfers-button"
          onClick={() => setOpen((prev) => !prev)}
        >
          <ArrowLeftRight className="h-4 w-4" />
        </Button>
      </IconTooltip>
      <RunningBadge count={runningNodeJobCount(jobs)} />
      {/* 量完才渲染：placement 决定 fixed 的坐标，先渲染会在 body 左上角闪一帧 */}
      {open &&
        placement &&
        createPortal(
          <div
            ref={panelRef}
            // biome-ignore lint/a11y/useSemanticElements: 非模态浮层，原生 <dialog> 的顶层与焦点陷阱语义不适用
            role="dialog"
            aria-label={label}
            data-testid="explorer-transfers-popover"
            style={panelStyle(placement)}
            className="vibeterm-fade fixed z-50 overflow-y-auto rounded-xl bg-popover p-3 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10"
          >
            <ExplorerTransfersPanel jobCount={jobs.length} options={options} />
          </div>,
          document.body
        )}
    </div>
  );
}
