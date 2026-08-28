import type { TerminalShortcutItem } from '@tmex/shared';
import { Switch } from '@tmex/ui/switch';
import { useTranslation } from 'react-i18next';

import { ShortcutButtonRow } from './ShortcutButtonRow';

/** 编辑器顶部的实时预览：直接复用终端栏的按钮排。 */
export function ShortcutPreview({
  items,
  useIcons,
}: {
  items: TerminalShortcutItem[];
  useIcons: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="space-y-2">
      <span className="block font-medium text-sm">{t('settings.terminal.shortcuts.preview')}</span>
      <div
        className="rounded-lg border border-border bg-muted/30 px-3"
        data-testid="shortcut-preview"
      >
        <ShortcutButtonRow items={items} useIcons={useIcons} />
      </div>
    </div>
  );
}

/** 图标开关（对齐设置项行：边框盒子 + 左标签右开关）。 */
export function ShortcutIconsToggle({
  useIcons,
  onChange,
}: {
  useIcons: boolean;
  onChange: (useIcons: boolean) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium text-sm">{t('settings.terminal.shortcuts.useIcons')}</span>
        <span className="text-muted-foreground text-xs">
          {t('settings.terminal.shortcuts.useIconsDesc')}
        </span>
      </span>
      <Switch
        checked={useIcons}
        onCheckedChange={onChange}
        aria-label={t('settings.terminal.shortcuts.useIcons')}
        data-testid="shortcut-use-icons"
      />
    </div>
  );
}
