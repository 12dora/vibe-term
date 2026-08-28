// 终端设置面板按需加载：打开时才拉 chunk，失败给可重试的兜底条。

import { Button } from '@tmex/ui/button';
import { type ComponentType, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

type TerminalSettingsSheetComponent = ComponentType<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>;

export interface TerminalSettingsFallbackView {
  role: 'alert' | 'status';
  messageKey: 'settings.terminal.loadFailed' | 'settings.terminal.loading';
  showRetry: boolean;
}

export function terminalSettingsFallbackView(loadError: boolean): TerminalSettingsFallbackView {
  return loadError
    ? { role: 'alert', messageKey: 'settings.terminal.loadFailed', showRetry: true }
    : { role: 'status', messageKey: 'settings.terminal.loading', showRetry: false };
}

export interface DeferredTerminalSettingsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DeferredTerminalSettingsSheet({
  open,
  onOpenChange,
}: DeferredTerminalSettingsSheetProps) {
  const { t } = useTranslation();
  const [SheetComponent, setSheetComponent] = useState<TerminalSettingsSheetComponent | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadAttempt is an explicit retry trigger
  useEffect(() => {
    if (!open || SheetComponent) return;
    let cancelled = false;
    setLoadError(false);
    void import('../settings/terminal-settings-sheet').then(
      (module) => {
        if (!cancelled) setSheetComponent(() => module.TerminalSettingsSheet);
      },
      () => {
        if (!cancelled) setLoadError(true);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [loadAttempt, open, SheetComponent]);

  if (SheetComponent) {
    return <SheetComponent open={open} onOpenChange={onOpenChange} />;
  }
  if (!open) return null;

  const fallback = terminalSettingsFallbackView(loadError);

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-50 border-t bg-background px-4 py-5 text-sm shadow-lg"
      role={fallback.role}
      aria-live="polite"
    >
      <div className="mx-auto flex max-w-md items-center justify-between gap-3">
        <span>{t(fallback.messageKey)}</span>
        <div className="flex gap-2">
          {fallback.showRetry && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLoadAttempt((value) => value + 1)}
            >
              {t('common.retry')}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t('common.close')}
          </Button>
        </div>
      </div>
    </div>
  );
}
