import type { TerminalShortcutAction } from '@tmex/shared';
import { cn } from '@tmex/ui';
import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ACTION_META } from './shortcut-action-meta';
import type { ShortcutAddFormModel } from './use-terminal-shortcuts-editor';

export interface ShortcutAddPanelProps {
  form: ShortcutAddFormModel;
  onAddAction: (action: TerminalShortcutAction) => void;
}

function CaptureButton({ form }: { form: ShortcutAddFormModel }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onKeyDown={form.onCaptureKeyDown}
      // Safari/WKWebView 桌面端点击 button 不赋予焦点，捕获态永远进不去——显式聚焦。
      onClick={(e) => e.currentTarget.focus()}
      onFocus={() => form.setCapturing(true)}
      onBlur={() => form.setCapturing(false)}
      className={cn(
        'w-full rounded-lg border px-3 py-2.5 text-center text-sm outline-none transition-colors',
        form.capturing
          ? 'border-primary bg-primary/5 text-foreground'
          : 'border-border text-muted-foreground'
      )}
      data-testid="shortcut-capture-input"
    >
      {form.capturing
        ? t('settings.terminal.shortcuts.capturePrompt')
        : t('settings.terminal.shortcuts.captureHint')}
    </button>
  );
}

function ActionButtons({ onAddAction }: { onAddAction: (action: TerminalShortcutAction) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-1.5">
      {ACTION_META.map(({ action, icon: Icon }) => (
        <Button
          key={action}
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onAddAction(action)}
          data-testid={`shortcut-add-action-${action}`}
        >
          <Icon className="h-3.5 w-3.5" />
          {t(`settings.terminal.shortcuts.action.${action}`)}
        </Button>
      ))}
    </div>
  );
}

function ManualFields({ form }: { form: ShortcutAddFormModel }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Input
        value={form.manualLabel}
        onChange={(e) => form.setManualLabel(e.target.value)}
        placeholder={t('settings.terminal.shortcuts.labelPlaceholder')}
        className="h-9 w-24 font-mono"
        data-testid="shortcut-manual-label"
      />
      <Input
        value={form.manualPayload}
        onChange={(e) => form.setManualPayload(e.target.value)}
        placeholder={t('settings.terminal.shortcuts.payloadPlaceholder')}
        spellCheck={false}
        className="h-9 min-w-0 flex-1 font-mono text-xs"
        data-testid="shortcut-manual-payload"
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={form.addManual}
        data-testid="shortcut-manual-add"
      >
        <Plus className="h-3.5 w-3.5" />
        {t('settings.terminal.shortcuts.add')}
      </Button>
    </div>
  );
}

/** 三种录入入口：按键捕获、内置动作、高级手填转义串。 */
export function ShortcutAddPanel({ form, onAddAction }: ShortcutAddPanelProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-3 rounded-lg border border-dashed border-border p-4">
      <span className="block font-medium text-sm">
        {t('settings.terminal.shortcuts.addShortcut')}
      </span>

      <CaptureButton form={form} />
      <ActionButtons onAddAction={onAddAction} />

      <button
        type="button"
        className="text-muted-foreground text-xs underline underline-offset-2"
        onClick={form.toggleAdvanced}
      >
        {t('settings.terminal.shortcuts.advanced')}
      </button>
      {form.advancedOpen && <ManualFields form={form} />}
    </div>
  );
}
