// 终端设置面板的懒加载壳：首次打开才拉起 chunk，失败时给出重试入口。

import { Button } from '@tmex/ui/button';
import { type ComponentType, useEffect, useState } from 'react';

type TerminalSettingsSheetComponent = ComponentType<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>;

export function DeferredTerminalSettingsSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
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

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-50 border-t bg-background px-4 py-5 text-sm shadow-lg"
      role={loadError ? 'alert' : 'status'}
      aria-live="polite"
    >
      <div className="mx-auto flex max-w-md items-center justify-between gap-3">
        <span>
          {loadError ? 'Terminal settings failed to load.' : 'Loading terminal settings…'}
        </span>
        <div className="flex gap-2">
          {loadError && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLoadAttempt((value) => value + 1)}
            >
              Retry
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
