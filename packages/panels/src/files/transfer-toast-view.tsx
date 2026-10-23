// 传输 Toast 的工作态内容（纯展示，渲染在 sonner 默认卡片内）。
// 单个条目：一条进度条 + 阶段；多个条目：总览条 + 可滚动的逐条列表。

import { formatBytesPair, formatRate } from '@vibeterm/api-client';
import { ByteRate } from '@vibeterm/ui/byte-rate';
import { Progress } from '@vibeterm/ui/progress';
import type { TFunction } from 'i18next';
import type { TransferPath } from './bulk-transfer';
import type { BatchView, ItemView } from './transfer-progress';

export interface ToastBodyModel {
  title: string;
  view: BatchView;
  /** 网络那一段的实时速率（字节/秒）。 */
  ratePerSec: number;
}

interface TProps {
  t: TFunction;
}

export function PathBadge({ path, t }: TProps & { path: TransferPath }) {
  const direct = path === 'direct';
  return (
    <span
      data-testid="transfer-path-badge"
      title={t(direct ? 'files.transfer.pathDirectHint' : 'files.transfer.pathRelayHint')}
      className="shrink-0 rounded border px-1 text-[10px] leading-4 text-muted-foreground transition-colors duration-(--vibeterm-motion-fast) ease-out motion-reduce:transition-none"
    >
      {t(direct ? 'files.transfer.pathDirect' : 'files.transfer.pathRelay')}
    </span>
  );
}

function Header({ title, path, t }: TProps & { title: string; path: TransferPath | null }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 truncate text-sm font-medium">{title}</span>
      {path ? <PathBadge path={path} t={t} /> : null}
    </div>
  );
}

// 速率与「已传 / 总量」合成一段靠右的文本：数字等宽（tabular-nums）所以位数变化不会抖，
// 不再给每一项预留最大宽度，否则会留下孤零零的分隔点和一大片空白。
function RateDetail({ model }: { model: ToastBodyModel }) {
  const { ratePerSec, view } = model;
  const parts: string[] = [];
  if (ratePerSec > 0) parts.push(formatRate(ratePerSec));
  if (view.totalBytes > 0) parts.push(formatBytesPair(view.transferredBytes, view.totalBytes));
  if (parts.length === 0) return null;
  return (
    <ByteRate minWidthClass="min-w-0" className="shrink-0" data-testid="transfer-rate-detail">
      {parts.join(' · ')}
    </ByteRate>
  );
}

function SingleBody({ model, t }: TProps & { model: ToastBodyModel }) {
  const { title, view } = model;
  const stage = view.rows[0]?.stage ?? 'transferring';
  return (
    <div className="flex w-full min-w-0 flex-col gap-2" data-testid="transfer-toast">
      <Header title={title} path={view.path} t={t} />
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate" data-testid="transfer-stage">
          {t(`files.transfer.stage.${stage}`)}
        </span>
        <RateDetail model={model} />
      </div>
      <Progress value={view.pct} />
    </div>
  );
}

function ItemRow({ row, t }: TProps & { row: ItemView }) {
  const showPct = row.stage === 'transferring';
  return (
    <li className="flex flex-col gap-0.5" data-testid="transfer-item">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="min-w-0 truncate">{row.name}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {showPct ? `${row.pct}%` : t(`files.transfer.stage.${row.stage}`)}
        </span>
      </div>
      <Progress value={row.pct} className="h-1" />
    </li>
  );
}

function BatchBody({ model, t }: TProps & { model: ToastBodyModel }) {
  const { title, view } = model;
  return (
    <div className="flex w-full min-w-0 flex-col gap-2" data-testid="transfer-toast">
      <Header title={title} path={view.path} t={t} />
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate" data-testid="transfer-batch-progress">
          {t('files.transfer.batchProgress', { done: view.itemsDone, total: view.itemsTotal })}
        </span>
        <RateDetail model={model} />
      </div>
      <Progress value={view.pct} />
      <ul className="flex max-h-36 flex-col gap-1.5 overflow-y-auto pr-1">
        {view.rows.map((row) => (
          <ItemRow key={row.index} row={row} t={t} />
        ))}
      </ul>
    </div>
  );
}

export function ToastBody({ model, t }: TProps & { model: ToastBodyModel }) {
  return model.view.itemsTotal > 1 ? (
    <BatchBody model={model} t={t} />
  ) : (
    <SingleBody model={model} t={t} />
  );
}
