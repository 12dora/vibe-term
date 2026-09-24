// 本机卡「内存限额」段：每个 tmux 窗口的 systemd pane scope 上限 + 采样周期。
// 记录整条读写：进来 GET 一次，保存时把五个字段全量 PUT 回去。表单字段与节点表对话框共用。

import {
  type SessionsMemoryResponse,
  getSessionsMemory,
  getWindowMemorySettings,
  putWindowMemorySettings,
} from '@vibeterm/api-client';
import { type WindowMemorySettings, errorMessage } from '@vibeterm/shared';
import { Button } from '@vibeterm/ui/button';
import { Loader2, Save } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Notice } from '../components/form-primitives';
import { MemoryLimitsFields } from './management/memory-limits-fields';
import {
  type MemoryLimitsDraft,
  type MemoryLimitsErrors,
  memoryLimitsDraft,
  submitMemoryLimits,
} from './memory-limits-form';
import { MemoryLimitsReleaseNotice, memoryLimitsReleaseReport } from './memory-limits-release';
import {
  MemoryLimitsUnsupportedNotice,
  type SessionsMemoryLoader,
  unsupportedDeviceNames,
  useSessionsMemorySnapshot,
} from './memory-limits-unsupported';

export interface MemoryLimitsApi {
  get: () => Promise<WindowMemorySettings>;
  put: (settings: WindowMemorySettings) => Promise<WindowMemorySettings>;
  /** 只用来判断限额在哪些宿主上不会生效；缺省不拉，表单照常工作。 */
  sessionsMemory?: SessionsMemoryLoader;
}

const listSessionsMemory = (): Promise<SessionsMemoryResponse> => getSessionsMemory();

const defaultMemoryLimitsApi: MemoryLimitsApi = {
  get: () => getWindowMemorySettings(),
  put: (settings) => putWindowMemorySettings(settings),
  sessionsMemory: listSessionsMemory,
};

function useMemoryLimits(api: MemoryLimitsApi) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<MemoryLimitsDraft | null>(null);
  // 打开时读到的记录，拿来对照窗口读数；保存后清空——网关还没来得及放开，这时对照只会误报。
  const [baseline, setBaseline] = useState<WindowMemorySettings | null>(null);
  const [errors, setErrors] = useState<MemoryLimitsErrors>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .get()
      .then((settings) => {
        if (!alive) return;
        setDraft(memoryLimitsDraft(settings));
        setBaseline(settings);
      })
      .catch((err) => {
        if (alive)
          setLoadError(t('settings.nodes.memory.loadFailed', { message: errorMessage(err) }));
      });
    return () => {
      alive = false;
    };
  }, [api, t]);

  const update = useCallback((patch: Partial<MemoryLimitsDraft>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    const result = await submitMemoryLimits(draft, api.put);
    setErrors(result.errors);
    setSaving(false);
    if (result.saved) {
      setDraft(memoryLimitsDraft(result.saved));
      setBaseline(null);
      toast.success(t('settings.nodes.memory.saved'));
      return;
    }
    if (result.failure) {
      toast.error(t('settings.nodes.memory.saveFailed', { message: result.failure }));
    }
  }, [api, draft, t]);

  return { draft, baseline, errors, loadError, saving, update, save };
}

export function MemoryLimitsSection({ api = defaultMemoryLimitsApi }: { api?: MemoryLimitsApi }) {
  const { t } = useTranslation();
  const { draft, baseline, errors, loadError, saving, update, save } = useMemoryLimits(api);
  const sessions = useSessionsMemorySnapshot(api.sessionsMemory);
  const now = Date.now();
  const releaseReport = memoryLimitsReleaseReport(sessions, baseline, now);

  if (loadError) {
    return (
      <Notice tone="error" testId="memory-limits-load-failed">
        <p>{loadError}</p>
      </Notice>
    );
  }
  if (!draft) {
    return (
      <Loader2
        className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
        data-testid="memory-limits-loading"
      />
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="memory-limits-form">
      <MemoryLimitsUnsupportedNotice deviceNames={unsupportedDeviceNames(sessions)} />
      <MemoryLimitsReleaseNotice report={releaseReport} now={now} testId="memory-limits-release" />
      <p className="text-xs text-muted-foreground">{t('settings.nodes.memory.description')}</p>
      <MemoryLimitsFields
        draft={draft}
        errors={errors}
        idPrefix="memory"
        disabled={saving}
        onChange={update}
      />
      <div className="flex justify-end pt-1">
        <Button
          type="button"
          variant="secondary"
          disabled={saving}
          onClick={() => void save()}
          data-testid="memory-limits-save"
          className="w-full sm:w-auto"
        >
          <Save className="h-4 w-4" />
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}
