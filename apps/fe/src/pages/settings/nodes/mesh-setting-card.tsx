// 设置 → 多节点互联：枚举型节点设置的通用卡片（延迟优化、节点连接代理共用）。
// 乐观更新失败回滚并 toast；选项卡由 ChoiceCard 渲染，文案键为 `${i18nPrefix}.${value}.{title,description}`。

import { Card, CardContent, CardHeader, CardTitle } from '@vibeterm/ui/card';
import { Skeleton } from '@vibeterm/ui/skeleton';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ChoiceCard } from '../remote-access/choice-card';

export interface MeshSettingApi<T extends string> {
  get(): Promise<T>;
  set(value: T): Promise<T>;
}

/** 乐观切到 next，失败回滚到 current 并交给 onError。同值不发请求。 */
export async function applyMeshSettingSelection<T extends string>(opts: {
  current: T;
  next: T;
  set: (value: T) => Promise<T>;
  onOptimistic: (value: T) => void;
  onCommitted: (value: T) => void;
  onRollback: (value: T) => void;
  onError: (error: unknown) => void;
}): Promise<void> {
  if (opts.next === opts.current) return;
  opts.onOptimistic(opts.next);
  try {
    opts.onCommitted(await opts.set(opts.next));
  } catch (error) {
    opts.onRollback(opts.current);
    opts.onError(error);
  }
}

export interface MeshSettingSpec<T extends string> {
  /** testid 前缀：`${testId}-card` / `-chooser` / `-skeleton` / `-${value}`，同时作为单选组名。 */
  testId: string;
  i18nPrefix: string;
  values: readonly T[];
  icons: Record<T, ReactNode>;
  defaultValue: T;
  /** 选项卡每行列数（Tailwind 类需写成字面量）。 */
  columns: 2 | 3;
}

const GRID_COLUMNS = { 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3' } as const;

export function MeshSettingChooser<T extends string>({
  spec,
  value,
  disabled,
  onSelect,
}: {
  spec: MeshSettingSpec<T>;
  value: T;
  disabled: boolean;
  onSelect: (value: T) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={`grid gap-3 ${GRID_COLUMNS[spec.columns]}`}
      role="radiogroup"
      aria-label={t(`${spec.i18nPrefix}.title`)}
      data-testid={`${spec.testId}-chooser`}
    >
      {spec.values.map((item) => (
        <ChoiceCard
          key={item}
          group={spec.testId}
          value={item}
          icon={spec.icons[item]}
          selected={value === item}
          disabled={disabled}
          onSelect={onSelect}
          testidPrefix={spec.testId}
          i18nPrefix={spec.i18nPrefix}
        />
      ))}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MeshSettingCard<T extends string>({
  spec,
  api,
}: {
  spec: MeshSettingSpec<T>;
  api: MeshSettingApi<T>;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState<T>(spec.defaultValue);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const i18n = spec.i18nPrefix;

  useEffect(() => {
    let cancelled = false;
    void api
      .get()
      .then((next) => {
        if (cancelled) return;
        setValue(next);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoaded(true);
        toast.error(t(`${i18n}.loadFailed`, { message: errorMessage(error) }));
      });
    return () => {
      cancelled = true;
    };
  }, [api, i18n, t]);

  const onSelect = useCallback(
    (next: T) => {
      if (saving) return;
      setSaving(true);
      void applyMeshSettingSelection({
        current: value,
        next,
        set: api.set,
        onOptimistic: setValue,
        onCommitted: setValue,
        onRollback: setValue,
        onError: (error) => toast.error(t(`${i18n}.saveFailed`, { message: errorMessage(error) })),
      }).finally(() => setSaving(false));
    },
    [value, api, saving, t, i18n]
  );

  return (
    <Card data-testid={`${spec.testId}-card`}>
      <CardHeader>
        <CardTitle>{t(`${i18n}.title`)}</CardTitle>
      </CardHeader>
      <CardContent>
        {loaded ? (
          <MeshSettingChooser spec={spec} value={value} disabled={saving} onSelect={onSelect} />
        ) : (
          <Skeleton className="h-24 w-full" data-testid={`${spec.testId}-skeleton`} />
        )}
      </CardContent>
    </Card>
  );
}
