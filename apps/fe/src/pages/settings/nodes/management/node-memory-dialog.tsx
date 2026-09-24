// 单台节点的「内存限额」对话框：打开时 GET 该节点当前值，保存时整条 PUT 回去。
//
// 走的是目标节点自己的 `/api/settings/window-memory`（本机无前缀，远端经 `/n/<id>`），
// 与本机卡那一段是同一份记录、同一套校验。
//
// 写进设置不等于宿主能限额：同时拉一次目标节点的 `/api/sessions/memory`，宿主没有
// pane scope 时在表单上方把「写了也不生效」说清楚；设置已是「不限制」而窗口读数仍带限额时，
// 按读数新旧分别说「仍带限额」或「读数已过期」。这一发失败不影响表单与保存。

import type { NodeRow } from '@/node/mesh-nodes';
import type { WindowMemorySettings } from '@vibeterm/shared';
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
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Notice } from '../../components/form-primitives';
import {
  type MemoryLimitsDraft,
  type MemoryLimitsErrors,
  memoryLimitsDraft,
} from '../memory-limits-form';
import {
  MemoryLimitsReleaseNotice,
  type MemoryLimitsReleaseReport,
  memoryLimitsReleaseReport,
} from '../memory-limits-release';
import { useSessionsMemorySnapshot } from '../memory-limits-unsupported';
import { MemoryLimitsFields } from './memory-limits-fields';
import {
  type MemoryLimitsIo,
  defaultMemoryLimitsIo,
  memoryLimitsErrorText,
  memoryLimitsUnsupportedDevices,
  runMemoryLimitsSave,
} from './node-memory-limits';

export interface NodeMemoryDialogBodyProps {
  nodeId: string;
  draft: MemoryLimitsDraft | null;
  errors: MemoryLimitsErrors;
  loadError: string | null;
  saving: boolean;
  /** 该节点上限额落不到 cgroup 的设备名；为空即不提示。 */
  unsupportedDevices?: string[];
  /** 「设置已是不限制、窗口读数仍带限额」的对照结果；`null` 即不提示。 */
  releaseReport?: MemoryLimitsReleaseReport | null;
  now?: number;
  onChange: (patch: Partial<MemoryLimitsDraft>) => void;
}

/** 对话框正文。单独导出：Dialog 走 portal，静态渲染只看得到这一块。 */
export function NodeMemoryDialogBody({
  nodeId,
  draft,
  errors,
  loadError,
  saving,
  unsupportedDevices = [],
  releaseReport = null,
  now = Date.now(),
  onChange,
}: NodeMemoryDialogBodyProps) {
  const { t } = useTranslation();

  let content: ReactNode;
  if (loadError) {
    content = (
      <Notice tone="error" testId={`nodes-memory-load-failed-${nodeId}`}>
        <p>{loadError}</p>
      </Notice>
    );
  } else if (!draft) {
    content = (
      <Loader2
        className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
        data-testid={`nodes-memory-loading-${nodeId}`}
      />
    );
  } else {
    content = (
      <>
        <p className="text-xs text-muted-foreground">{t('settings.nodes.memory.description')}</p>
        <MemoryLimitsFields
          draft={draft}
          errors={errors}
          idPrefix={`nodes-memory-${nodeId}`}
          disabled={saving}
          onChange={onChange}
        />
      </>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {unsupportedDevices.length > 0 && (
        <Notice tone="warning" testId={`nodes-memory-unsupported-${nodeId}`}>
          <p>
            {t('settings.nodes.memory.limitsUnsupported', {
              devices: unsupportedDevices.join('、'),
            })}
          </p>
          <p>{t('settings.nodes.memory.limitsUnsupportedHint')}</p>
        </Notice>
      )}
      <MemoryLimitsReleaseNotice
        report={releaseReport}
        now={now}
        testId={`nodes-memory-release-${nodeId}`}
      />
      {content}
    </div>
  );
}

function useNodeMemoryLimits(row: NodeRow, io: MemoryLimitsIo, onSaved: () => void) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<MemoryLimitsDraft | null>(null);
  const [errors, setErrors] = useState<MemoryLimitsErrors>({});
  // 原始异常存着、渲染时才翻译：这样读取回路不依赖 `t`，切语言不会把草稿冲掉重拉。
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  const [saving, setSaving] = useState(false);
  // 只对照打开时读到的那份记录：保存成功后对话框即关闭，不会拿刚写下的值去比旧读数。
  const [baseline, setBaseline] = useState<WindowMemorySettings | null>(null);
  // 节点列表每次刷新都会换一个新的行对象：拿 ref 读它，否则草稿会被重新 GET 冲掉。
  const rowRef = useRef(row);
  rowRef.current = row;
  // 保存是在途的异步：卸载后不能再写 state，也不能再弹提示。
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // 对话框关掉即卸载，这一发只在打开时跑：目标节点由挂载那一刻的行决定。
  useEffect(() => {
    let alive = true;
    io.get(rowRef.current)
      .then((settings) => {
        if (!alive) return;
        setDraft(memoryLimitsDraft(settings));
        setBaseline(settings);
      })
      .catch((err) => {
        if (alive) setFailure({ error: err });
      });
    return () => {
      alive = false;
    };
  }, [io]);

  // 这一发只用来提示：拉不到就不提示，绝不能挡住限额表单。
  const loadSessions = useMemo(() => {
    const load = io.sessions;
    return load ? () => load(rowRef.current) : undefined;
  }, [io]);
  const sessions = useSessionsMemorySnapshot(loadSessions);

  const update = useCallback((patch: Partial<MemoryLimitsDraft>) => {
    setDraft((previous) => (previous ? { ...previous, ...patch } : previous));
  }, []);

  const save = useCallback(async () => {
    if (!draft) return;
    await runMemoryLimitsSave({
      draft,
      put: (settings) => io.put(rowRef.current, settings),
      t,
      alive: () => aliveRef.current,
      setSaving,
      setErrors,
      setDraft,
      onSaved,
      notify: (level, text) => (level === 'success' ? toast.success(text) : toast.error(text)),
    });
  }, [draft, io, onSaved, t]);

  const loadError = failure
    ? t('settings.nodes.memory.loadFailed', { message: memoryLimitsErrorText(t, failure.error) })
    : null;

  const now = Date.now();
  const unsupportedDevices = sessions ? memoryLimitsUnsupportedDevices(sessions) : [];
  const releaseReport = memoryLimitsReleaseReport(sessions, baseline, now);

  return { draft, errors, loadError, saving, unsupportedDevices, releaseReport, now, update, save };
}

export function NodeMemoryDialog({
  row,
  open,
  onOpenChange,
  io = defaultMemoryLimitsIo,
}: {
  row: NodeRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 测试注入；缺省走真实端点。 */
  io?: MemoryLimitsIo;
}) {
  const { t } = useTranslation();
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { draft, errors, loadError, saving, unsupportedDevices, releaseReport, now, update, save } =
    useNodeMemoryLimits(row, io, close);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 写入在途时 Esc / 遮罩 / 关闭键一律不关：框一卸载，PUT 仍会落地，用户却以为取消了。
        if (!next && saving) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
        showCloseButton={!saving}
        data-testid={`nodes-memory-dialog-${row.id}`}
      >
        <DialogHeader>
          <DialogTitle>{t('settings.nodes.memory.title')}</DialogTitle>
          <DialogDescription className="truncate">
            {t('nodes.memory.target', { name: row.name })}
          </DialogDescription>
        </DialogHeader>

        <NodeMemoryDialogBody
          nodeId={row.id}
          draft={draft}
          errors={errors}
          loadError={loadError}
          saving={saving}
          unsupportedDevices={unsupportedDevices}
          releaseReport={releaseReport}
          now={now}
          onChange={update}
        />

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="secondary"
            disabled={saving || !draft}
            onClick={() => void save()}
            data-testid={`nodes-memory-save-${row.id}`}
          >
            {saving ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Save />}
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
