// 批量「内存限额」对话框：一份表单写到所选节点上。
//
// 不用 `ConfirmDialog`——它的输入槽只放得下一行文本，这里有一个开关加四个数字。
// 版式沿用详情框（`Dialog`），目标 / 跳过清单与卸载确认框共用 `PlanRows`。
//
// 批量不读各节点的旧值，所以方式（不限制 / 自定义限额）一开始是空的，选了才能写入：
// 原封不动点「写入」不能把缺省的 8 / 12 GB 装到每一台上。

import { WINDOW_MEMORY_SETTINGS_DEFAULTS } from '@vibeterm/shared';
import { Button } from '@vibeterm/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibeterm/ui/dialog';
import { Loader2, Save } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type MemoryLimitsDraft,
  type MemoryLimitsErrors,
  type MemoryLimitsMode,
  memoryLimitsDraft,
  parseBulkMemoryLimits,
} from '../memory-limits-form';
import { MemoryLimitsFields } from './memory-limits-fields';
import {
  type MemoryLimitsFailure,
  type MemoryLimitsPlan,
  type MemoryLimitsSkipReason,
  memoryLimitsFailureLabels,
} from './node-memory-limits';
import { PlanRows } from './plan-rows';
import type { MemoryLimitsBatchController } from './use-memory-limits-batch';

const SKIP_KEY: Record<MemoryLimitsSkipReason, string> = {
  tooOld: 'nodes.memory.skip.tooOld',
  offline: 'nodes.memory.skip.offline',
  loginRequired: 'nodes.memory.skip.loginRequired',
  paused: 'nodes.memory.skip.paused',
};

/** 「写给谁、谁被跳过、上一批谁失败了」。单独导出：Dialog 走 portal，静态渲染只看得到这一块。 */
export function BulkMemoryDialogBody({
  plan,
  failures,
}: {
  plan: MemoryLimitsPlan;
  failures: MemoryLimitsFailure[];
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2 text-xs" data-testid="nodes-memory-bulk-body">
      <p className="text-muted-foreground" data-testid="nodes-memory-bulk-effect">
        {t('nodes.memory.bulkEffectHint')}
      </p>
      <PlanRows plan={plan} skipKey={SKIP_KEY} ns="nodes.memory" testIdPrefix="nodes-memory" />

      {failures.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-destructive">{t('nodes.memory.failedTitle')}</p>
          <ul className="flex flex-col gap-0.5 text-destructive">
            {/* key 用 id 而不是名字：节点重名时同一个 key 会把两条失败合成一条，旧文案还会留在 DOM 上。 */}
            {memoryLimitsFailureLabels(t, failures).map((item) => (
              <li key={item.id} className="truncate" data-testid={`nodes-memory-failed-${item.id}`}>
                {item.label}｜{item.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function BulkMemoryDialog({ controller }: { controller: MemoryLimitsBatchController }) {
  const { t } = useTranslation();
  const { plan, running, failures } = controller;
  const [draft, setDraft] = useState<MemoryLimitsDraft>(() =>
    memoryLimitsDraft(WINDOW_MEMORY_SETTINGS_DEFAULTS)
  );
  const [mode, setMode] = useState<MemoryLimitsMode | null>(null);
  const [errors, setErrors] = useState<MemoryLimitsErrors>({});
  if (!plan) return null;

  const apply = () => {
    const parsed = parseBulkMemoryLimits(mode, draft);
    setErrors(parsed.errors);
    if (parsed.settings) controller.run(parsed.settings);
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !running) controller.dismiss();
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
        data-testid="nodes-memory-bulk-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t('nodes.memory.bulkTitle')}</DialogTitle>
          <DialogDescription>{t('nodes.memory.bulkDescription')}</DialogDescription>
        </DialogHeader>

        <MemoryLimitsFields
          draft={draft}
          errors={errors}
          idPrefix="nodes-memory-bulk"
          disabled={running}
          mode={mode}
          onModeChange={setMode}
          onChange={(patch) => setDraft((previous) => ({ ...previous, ...patch }))}
        />
        {mode === null && (
          <p className="text-xs text-muted-foreground" data-testid="nodes-memory-bulk-choose-mode">
            {t('nodes.memory.chooseMode')}
          </p>
        )}
        <BulkMemoryDialogBody plan={plan} failures={failures} />

        <DialogFooter>
          <Button variant="outline" disabled={running} onClick={controller.dismiss}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="secondary"
            disabled={running || mode === null || plan.targets.length === 0}
            onClick={apply}
            data-testid="nodes-memory-bulk-apply"
          >
            {running ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Save />}
            {t('nodes.memory.apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
