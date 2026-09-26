// 「登录历史」对话框：本机卡 ⋯ 菜单打开。成功 / 失败两个页签，逐台节点拉取后合成一张表；
// 右上角的保留时间与清空记录作用于全部可访问的节点，问不了的节点以标签列出原因。

import { LOGIN_RECORD_RETENTION_CHOICES } from '@vibeterm/shared';
import { Badge } from '@vibeterm/ui/badge';
import { Button } from '@vibeterm/ui/button';
import { ConfirmDialog } from '@vibeterm/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@vibeterm/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@vibeterm/ui/select';
import { Switch } from '@vibeterm/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@vibeterm/ui/tabs';
import { toast } from '@vibeterm/ui/toast';
import { Loader2, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  LoginHistoryBatchResult,
  LoginHistoryIo,
  LoginHistoryOutcome,
  LoginHistoryQuery,
} from './login-history-data';
import type {
  LoginHistoryPlan,
  LoginHistorySkip,
  LoginHistorySkipReason,
} from './login-history-nodes';
import { LoginHistoryTable } from './login-history-table';
import {
  type LoginHistoryState,
  useLoginHistoryClear,
  useLoginHistoryPlan,
  useLoginHistoryRecords,
  useLoginHistoryRetention,
} from './use-login-history';

type Translate = (key: string, options?: Record<string, unknown>) => string;

const NS = 'settings.loginHistory';

const SKIP_KEY: Record<LoginHistorySkipReason, string> = {
  offline: `${NS}.skip.offline`,
  tooOld: `${NS}.skip.tooOld`,
  loginRequired: `${NS}.skip.loginRequired`,
  paused: `${NS}.skip.paused`,
  failed: `${NS}.skip.failed`,
};

export function retentionLabel(t: Translate, days: number): string {
  return days === 0 ? t(`${NS}.retention.forever`) : t(`${NS}.retention.days`, { n: days });
}

/** 同一台节点可能既在计划里被跳过、又在拉取时失败：按节点去重，先到的原因为准。 */
export function mergeSkips(...groups: LoginHistorySkip[][]): LoginHistorySkip[] {
  const seen = new Set<string>();
  const out: LoginHistorySkip[] = [];
  for (const group of groups) {
    for (const item of group) {
      if (seen.has(item.node.id)) continue;
      seen.add(item.node.id);
      out.push(item);
    }
  }
  return out;
}

export function SkippedNodeChips({ skipped }: { skipped: LoginHistorySkip[] }) {
  const { t } = useTranslation();
  if (skipped.length === 0) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
      data-testid="login-history-skipped"
    >
      <span>{t(`${NS}.skippedLabel`)}</span>
      {skipped.map((item) => (
        <Badge
          key={item.node.id}
          variant="outline"
          className="font-normal"
          data-testid={`login-history-skipped-${item.node.id}`}
          data-reason={item.reason}
        >
          {item.node.name} · {t(SKIP_KEY[item.reason])}
        </Badge>
      ))}
    </div>
  );
}

/** 批量操作的汇总提示：全部成功一句；有跳过的节点列出名字与原因。 */
export function batchSummaryText(
  t: Translate,
  successKey: string,
  result: LoginHistoryBatchResult,
  skipped: LoginHistorySkip[]
): { level: 'success' | 'warning'; text: string } {
  const all = mergeSkips(result.failed, skipped);
  const base = t(successKey, { count: result.done.length, deleted: result.deleted });
  if (all.length === 0) return { level: 'success', text: base };
  const names = all
    .map((item) =>
      t(`${NS}.skippedItem`, { name: item.node.name, reason: t(SKIP_KEY[item.reason]) })
    )
    .join(t(`${NS}.listSeparator`));
  return { level: 'warning', text: t(`${NS}.partial`, { base, names }) };
}

export interface LoginHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  io?: LoginHistoryIo;
}

export function LoginHistoryDialog({ open, onOpenChange, io }: LoginHistoryDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-3 overflow-hidden sm:max-w-5xl"
        data-testid="login-history-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t(`${NS}.title`)}</DialogTitle>
          <DialogDescription>{t(`${NS}.description`)}</DialogDescription>
        </DialogHeader>
        {open ? <LoginHistoryBody io={io} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function LoginHistoryBody({ io }: { io?: LoginHistoryIo }) {
  const { t } = useTranslation();
  const { plan, ready } = useLoginHistoryPlan(true);
  const [outcome, setOutcome] = useState<LoginHistoryOutcome>('success');
  const [includeBackground, setIncludeBackground] = useState(false);
  const query = useMemo<LoginHistoryQuery>(
    () => ({ outcome, includeBackground }),
    [outcome, includeBackground]
  );
  const records = useLoginHistoryRecords(plan.targets, query, { enabled: ready, io });
  const retention = useLoginHistoryRetention(plan.targets, { enabled: ready, io });
  const clearing = useLoginHistoryClear(plan.targets, io);
  const [confirmClear, setConfirmClear] = useState(false);
  const skipped = useMemo(
    () => mergeSkips(plan.skipped, records.failed),
    [plan.skipped, records.failed]
  );

  const notify = (key: string, result: LoginHistoryBatchResult) => {
    const summary = batchSummaryText(t, key, result, plan.skipped);
    toast[summary.level](summary.text);
  };
  const clearAll = async () => {
    setConfirmClear(false);
    notify(`${NS}.clear.done`, await clearing.clear());
    records.reload();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <LoginHistoryToolbar
        outcome={outcome}
        onOutcomeChange={setOutcome}
        includeBackground={includeBackground}
        onIncludeBackgroundChange={setIncludeBackground}
        retention={retention.value}
        retentionBusy={retention.saving || !ready}
        onRetentionChange={(days) =>
          void retention.apply(days).then((result) => notify(`${NS}.retention.saved`, result))
        }
        clearBusy={clearing.clearing || !ready || plan.targets.length === 0}
        onClear={() => setConfirmClear(true)}
      />
      <SkippedNodeChips skipped={skipped} />
      <LoginHistoryRecordsView records={records} outcome={outcome} plan={plan} ready={ready} />
      <ConfirmDialog
        open={confirmClear}
        title={t(`${NS}.clear.confirmTitle`)}
        cancelLabel={t('common.cancel')}
        confirmLabel={t(`${NS}.clear.confirm`)}
        variant="destructive"
        onConfirm={() => void clearAll()}
        onCancel={() => setConfirmClear(false)}
        testId="login-history-clear-confirm"
        confirmTestId="login-history-clear-confirm-ok"
      >
        {t(`${NS}.clear.confirmBody`)}
      </ConfirmDialog>
    </div>
  );
}

function LoginHistoryRecordsView({
  records,
  outcome,
  plan,
  ready,
}: {
  records: LoginHistoryState;
  outcome: LoginHistoryOutcome;
  plan: LoginHistoryPlan;
  ready: boolean;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  const nodeNames = useMemo(() => nodeNameMap(plan), [plan]);

  useEffect(() => {
    if (!records.loading) setNow(Date.now());
  }, [records.loading]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {records.loading || !ready ? (
        <div
          className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground"
          data-testid="login-history-loading"
        >
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
          {t('common.loading')}
        </div>
      ) : (
        <LoginHistoryTable
          rows={records.rows}
          outcome={outcome}
          now={now}
          nodeNames={nodeNames}
          emptyText={t(outcome === 'success' ? `${NS}.empty.success` : `${NS}.empty.failed`)}
        />
      )}
      {records.hasMore && !records.loading && (
        <div className="flex justify-center pt-3">
          <Button
            variant="outline"
            size="sm"
            disabled={records.loadingMore}
            onClick={records.loadMore}
            data-testid="login-history-more"
          >
            {records.loadingMore ? (
              <Loader2 className="animate-spin motion-reduce:animate-none" />
            ) : null}
            {t(`${NS}.loadMore`)}
          </Button>
        </div>
      )}
    </div>
  );
}

function nodeNameMap(plan: LoginHistoryPlan): Map<string, string> {
  const names = new Map<string, string>();
  for (const node of plan.targets) names.set(node.meshId, node.name);
  for (const item of plan.skipped) names.set(item.node.meshId, item.node.name);
  return names;
}

export interface LoginHistoryToolbarProps {
  outcome: LoginHistoryOutcome;
  onOutcomeChange: (outcome: LoginHistoryOutcome) => void;
  includeBackground: boolean;
  onIncludeBackgroundChange: (next: boolean) => void;
  /** 各节点一致时的保留天数；不一致为 `null`。 */
  retention: number | null;
  retentionBusy: boolean;
  onRetentionChange: (days: number) => void;
  clearBusy: boolean;
  onClear: () => void;
}

export function LoginHistoryToolbar(props: LoginHistoryToolbarProps) {
  const { t } = useTranslation();
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2"
      data-testid="login-history-toolbar"
    >
      <Tabs
        value={props.outcome}
        onValueChange={(value) => props.onOutcomeChange(value as LoginHistoryOutcome)}
      >
        <TabsList>
          <TabsTrigger value="success" data-testid="login-history-tab-success">
            {t(`${NS}.tabs.success`)}
          </TabsTrigger>
          <TabsTrigger value="failed" data-testid="login-history-tab-failed">
            {t(`${NS}.tabs.failed`)}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {props.outcome === 'success' && (
        <label
          className="flex items-center gap-2 text-xs"
          htmlFor="login-history-background"
          title={t(`${NS}.showBackgroundHint`)}
        >
          <Switch
            id="login-history-background"
            size="sm"
            checked={props.includeBackground}
            onCheckedChange={(checked) => props.onIncludeBackgroundChange(checked)}
            data-testid="login-history-background"
          />
          {t(`${NS}.showBackground`)}
        </label>
      )}
      <div className="ml-auto flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{t(`${NS}.retention.label`)}</span>
        <Select
          value={props.retention === null ? null : String(props.retention)}
          onValueChange={(next) => {
            if (next !== null && next !== undefined) props.onRetentionChange(Number(next));
          }}
        >
          <SelectTrigger
            size="sm"
            disabled={props.retentionBusy}
            data-testid="login-history-retention"
          >
            <SelectValue>
              {props.retention === null
                ? t(`${NS}.retention.mixed`)
                : retentionLabel(t, props.retention)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {LOGIN_RECORD_RETENTION_CHOICES.map((days) => (
              <SelectItem key={days} value={String(days)}>
                {retentionLabel(t, days)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive"
          disabled={props.clearBusy}
          onClick={props.onClear}
          data-testid="login-history-clear"
        >
          <Trash2 />
          {t(`${NS}.clear.button`)}
        </Button>
      </div>
    </div>
  );
}
