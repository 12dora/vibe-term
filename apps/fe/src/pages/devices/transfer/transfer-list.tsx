// 弹窗下方的传输列表：节点间任务与浏览器上传 / 下载共用同一份 store，因此一起列。

import { formatBytes, formatEta, formatRate } from '@tmex/api-client';
import {
  BROWSER_ENDPOINT_ID,
  type TransferJobView,
  cancelTransferJobEntry,
  clearFinishedTransferJobs,
  isTerminalTransferState,
  useTransferJobs,
} from '@tmex/panels/files/transfers';
import { cn } from '@tmex/ui';
import { Button } from '@tmex/ui/button';
import { Progress } from '@tmex/ui/progress';
import { ScrollArea } from '@tmex/ui/scroll-area';
import { ArrowRight, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { DialogNodeOption } from '../dialog-nodes';

/** 端点名：优先按真实 mesh id 找，其次按运行时 id；浏览器一端用固定文案。 */
export function endpointLabel(
  id: string,
  options: DialogNodeOption[],
  browserLabel: string
): string {
  if (id === BROWSER_ENDPOINT_ID) return browserLabel;
  const option =
    options.find((item) => item.meshId === id) ?? options.find((item) => item.id === id);
  return option?.name ?? id.slice(0, 8);
}

const PATH_KEYS = {
  direct: 'files.transfer.pathDirect',
  relay: 'files.transfer.pathRelay',
  local: 'devices.transfer.pathLocal',
} as const;

function StateBadge({ view }: { view: TransferJobView }) {
  const { t } = useTranslation();
  const failed = view.state === 'failed';
  return (
    <span
      data-testid={`transfer-row-state-${view.state}`}
      className={cn(
        'shrink-0 rounded border px-1 py-px text-[10px] leading-none',
        failed ? 'border-destructive/40 text-destructive' : 'text-muted-foreground'
      )}
    >
      {t(`devices.transfer.state.${view.state}`)}
    </span>
  );
}

function TransferRow({ view, options }: { view: TransferJobView; options: DialogNodeOption[] }) {
  const { t } = useTranslation();
  const browser = t('devices.transfer.browser');
  const total = view.progress.totalBytes;

  return (
    <div className="flex flex-col gap-1 rounded-md px-2 py-1.5" data-testid="transfer-row">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{view.title}</span>
        {view.path && (
          <span className="shrink-0 rounded border px-1 py-px text-[10px] leading-none text-muted-foreground">
            {t(PATH_KEYS[view.path])}
          </span>
        )}
        <StateBadge view={view} />
        {view.cancellable && (
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid={`transfer-row-cancel-${view.jobId}`}
            aria-label={t('devices.transfer.cancel')}
            onClick={() => cancelTransferJobEntry(view.key)}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground">
        <span className="truncate">{endpointLabel(view.fromNodeId, options, browser)}</span>
        <ArrowRight className="h-3 w-3 shrink-0" />
        <span className="truncate">{endpointLabel(view.toNodeId, options, browser)}</span>
        {view.itemsTotal > 1 && (
          <span className="ml-2 shrink-0 tabular-nums">
            {t('devices.transfer.items', { done: view.itemsDone, total: view.itemsTotal })}
          </span>
        )}
        <span className="ml-auto shrink-0 tabular-nums">
          {total > 0
            ? `${formatBytes(view.progress.transferredBytes)} / ${formatBytes(total)}`
            : `${view.pct}%`}
        </span>
        {!isTerminalTransferState(view.state) && (
          <span className="shrink-0 tabular-nums">
            {formatRate(view.progress.ratePerSec)} · {formatEta(view.progress.etaSec)}
          </span>
        )}
      </div>
      <Progress value={view.pct} />
      {view.error && (
        <span className="text-[10px] text-destructive">
          {t(`devices.transfer.errors.${view.error}`, {
            defaultValue: t('devices.transfer.errors.unknown'),
          })}
        </span>
      )}
    </div>
  );
}

export function TransferJobsList({ options }: { options: DialogNodeOption[] }) {
  const { t } = useTranslation();
  const jobs = useTransferJobs();
  const hasFinished = jobs.some((view) => isTerminalTransferState(view.state));

  return (
    <section className="flex min-h-0 flex-col gap-1" data-testid="transfer-jobs">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{t('devices.transfer.list')}</span>
        <Button
          variant="ghost"
          size="sm"
          data-testid="transfer-clear-finished"
          disabled={!hasFinished}
          onClick={clearFinishedTransferJobs}
        >
          {t('devices.transfer.clearFinished')}
        </Button>
      </div>
      {jobs.length === 0 ? (
        <p
          className="py-4 text-center text-xs text-muted-foreground"
          data-testid="transfer-jobs-empty"
        >
          {t('devices.transfer.listEmpty')}
        </p>
      ) : (
        <ScrollArea className="max-h-40 rounded-lg border border-border">
          <div className="divide-y divide-border/60">
            {jobs.map((view) => (
              <TransferRow key={view.key} view={view} options={options} />
            ))}
          </div>
        </ScrollArea>
      )}
    </section>
  );
}
