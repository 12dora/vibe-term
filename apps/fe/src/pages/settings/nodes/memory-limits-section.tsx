// 本机卡「内存限额」段：每个 tmux 窗口的 systemd pane scope 上限 + 采样周期。
// 记录整条读写：进来 GET 一次，保存时把五个字段全量 PUT 回去。

import { getWindowMemorySettings, putWindowMemorySettings } from '@vibeterm/api-client';
import {
  WINDOW_MEMORY_INTERVAL_MAX_SEC,
  WINDOW_MEMORY_INTERVAL_MIN_SEC,
  WINDOW_MEMORY_MB_MAX,
  type WindowMemorySettings,
  errorMessage,
} from '@vibeterm/shared';
import { Button } from '@vibeterm/ui/button';
import { Input } from '@vibeterm/ui/input';
import { Switch } from '@vibeterm/ui/switch';
import { Loader2, Save } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormField, Notice } from '../components/form-primitives';
import {
  type MemoryLimitsDraft,
  type MemoryLimitsErrors,
  type MemoryLimitsField,
  memoryLimitsDraft,
  submitMemoryLimits,
} from './memory-limits-form';

export interface MemoryLimitsApi {
  get: () => Promise<WindowMemorySettings>;
  put: (settings: WindowMemorySettings) => Promise<WindowMemorySettings>;
}

const defaultMemoryLimitsApi: MemoryLimitsApi = {
  get: () => getWindowMemorySettings(),
  put: (settings) => putWindowMemorySettings(settings),
};

const MB_FIELDS: readonly { field: MemoryLimitsField; labelKey: string; hintKey?: string }[] = [
  {
    field: 'memoryHighMb',
    labelKey: 'settings.nodes.memory.high',
    hintKey: 'settings.nodes.memory.highHint',
  },
  {
    field: 'memoryMaxMb',
    labelKey: 'settings.nodes.memory.max',
    hintKey: 'settings.nodes.memory.maxHint',
  },
  { field: 'memorySwapMaxMb', labelKey: 'settings.nodes.memory.swapMax' },
];

type Translate = (key: string, options?: Record<string, unknown>) => string;

function fieldError(t: Translate, errors: MemoryLimitsErrors, field: MemoryLimitsField) {
  const key = errors[field];
  if (!key) return undefined;
  return t(key, {
    max: field === 'sampleIntervalSec' ? WINDOW_MEMORY_INTERVAL_MAX_SEC : WINDOW_MEMORY_MB_MAX,
    min: WINDOW_MEMORY_INTERVAL_MIN_SEC,
  });
}

function MemoryLimitsFields({
  draft,
  errors,
  onChange,
}: {
  draft: MemoryLimitsDraft;
  errors: MemoryLimitsErrors;
  onChange: (patch: Partial<MemoryLimitsDraft>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {MB_FIELDS.map((item) => (
        <FormField
          key={item.field}
          id={`memory-${item.field}`}
          label={t(item.labelKey)}
          hint={
            item.hintKey
              ? `${t(item.hintKey)} ${t('settings.nodes.memory.unlimitedHint')}`
              : t('settings.nodes.memory.unlimitedHint')
          }
          error={fieldError(t, errors, item.field)}
          spacing="tight"
        >
          <Input
            id={`memory-${item.field}`}
            inputMode="numeric"
            value={draft[item.field]}
            onChange={(event) => onChange({ [item.field]: event.target.value })}
            data-testid={`memory-${item.field}`}
          />
        </FormField>
      ))}
      <FormField
        id="memory-sampleIntervalSec"
        label={t('settings.nodes.memory.interval')}
        hint={t('settings.nodes.memory.intervalHint', {
          min: WINDOW_MEMORY_INTERVAL_MIN_SEC,
          max: WINDOW_MEMORY_INTERVAL_MAX_SEC,
        })}
        error={fieldError(t, errors, 'sampleIntervalSec')}
        spacing="tight"
      >
        <Input
          id="memory-sampleIntervalSec"
          inputMode="numeric"
          value={draft.sampleIntervalSec}
          onChange={(event) => onChange({ sampleIntervalSec: event.target.value })}
          data-testid="memory-sampleIntervalSec"
        />
      </FormField>
    </div>
  );
}

// Switch 的 id 落在 base-ui 藏起来的 checkbox 上，label htmlFor 只管点整行切换；
// role="switch" 那个 span 得靠 aria-labelledby 才有无障碍名（实测 Chromium AX 树：只给
// label htmlFor 时 name 为空串，补上 aria-labelledby 才念出文案）。
export function MemoryLimitsEnabledRow({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <label
      className="flex min-h-10 items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-2.5"
      htmlFor="memory-limits-enabled"
    >
      <span className="min-w-0 text-sm font-medium" id="memory-limits-enabled-label">
        {t('settings.nodes.memory.enabled')}
      </span>
      <Switch
        id="memory-limits-enabled"
        aria-labelledby="memory-limits-enabled-label"
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        data-testid="memory-limits-enabled"
      />
    </label>
  );
}

function useMemoryLimits(api: MemoryLimitsApi) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<MemoryLimitsDraft | null>(null);
  const [errors, setErrors] = useState<MemoryLimitsErrors>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .get()
      .then((settings) => {
        if (alive) setDraft(memoryLimitsDraft(settings));
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
      toast.success(t('settings.nodes.memory.saved'));
      return;
    }
    if (result.failure) {
      toast.error(t('settings.nodes.memory.saveFailed', { message: result.failure }));
    }
  }, [api, draft, t]);

  return { draft, errors, loadError, saving, update, save };
}

export function MemoryLimitsSection({ api = defaultMemoryLimitsApi }: { api?: MemoryLimitsApi }) {
  const { t } = useTranslation();
  const { draft, errors, loadError, saving, update, save } = useMemoryLimits(api);

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
      <p className="text-xs text-muted-foreground">{t('settings.nodes.memory.description')}</p>
      <MemoryLimitsEnabledRow
        checked={draft.enabled}
        onCheckedChange={(checked) => update({ enabled: checked })}
      />
      <MemoryLimitsFields draft={draft} errors={errors} onChange={update} />
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
