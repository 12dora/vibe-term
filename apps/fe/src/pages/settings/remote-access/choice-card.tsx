// 向导里的单选卡：连接方式、隧道类型与访问控制三组共用同一套外观与单选语义。
//
// `group` 同时决定 testid 与单选组名，`keyGroup` 决定文案键前缀（默认与 `group` 同名）。

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export function ChoiceCard<T extends string>({
  group,
  keyGroup = group,
  value,
  icon,
  selected,
  disabled,
  onSelect,
  testidPrefix,
  i18nPrefix,
}: {
  group: string;
  keyGroup?: string;
  value: T;
  icon: ReactNode;
  selected: boolean;
  disabled: boolean;
  onSelect: (value: T) => void;
  /** 缺省 `remote-access-${group}`，卡片与 radio 的 testid 前缀。 */
  testidPrefix?: string;
  /** 缺省 `settings.remoteAccess.${keyGroup}`，title / description 的 i18n 前缀。 */
  i18nPrefix?: string;
}) {
  const { t } = useTranslation();
  const testid = testidPrefix ?? `remote-access-${group}`;
  const i18n = i18nPrefix ?? `settings.remoteAccess.${keyGroup}`;
  return (
    <label
      data-testid={`${testid}-${value}`}
      data-selected={selected ? 'true' : 'false'}
      className={`flex cursor-pointer flex-col gap-1.5 rounded-xl p-3 text-left ring-1 has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring transition-colors duration-(--vibeterm-motion-fast) ease-out motion-reduce:transition-none ${
        selected ? 'bg-primary/5 ring-primary' : 'bg-card ring-foreground/10 hover:bg-muted/50'
      } ${disabled ? 'pointer-events-none opacity-60' : ''}`}
    >
      <input
        type="radio"
        name={testid}
        data-testid={`${testid}-${value}-input`}
        className="sr-only"
        checked={selected}
        disabled={disabled}
        onChange={() => onSelect(value)}
      />
      <span className="flex items-center gap-2 text-sm font-medium">
        {icon}
        {t(`${i18n}.${value}.title`)}
      </span>
      <span className="text-xs text-muted-foreground">{t(`${i18n}.${value}.description`)}</span>
    </label>
  );
}
