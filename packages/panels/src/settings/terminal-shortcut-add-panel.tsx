import type { TerminalShortcutAction } from '@tmex/shared';
import { keyEventToTerminalSequence, parseEscapeSequence } from '@tmex/terminal-ui';
import { cn } from '@tmex/ui';
import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { Plus } from 'lucide-react';
import { type KeyboardEvent as ReactKeyboardEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ACTION_META } from './terminal-shortcuts-model';

function ManualEntry({
  label,
  payload,
  onLabelChange,
  onPayloadChange,
  onAdd,
}: {
  label: string;
  payload: string;
  onLabelChange: (value: string) => void;
  onPayloadChange: (value: string) => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Input
        value={label}
        onChange={(e) => onLabelChange(e.target.value)}
        placeholder={t('settings.terminal.shortcuts.labelPlaceholder')}
        className="h-9 w-24 font-mono"
        data-testid="shortcut-manual-label"
      />
      <Input
        value={payload}
        onChange={(e) => onPayloadChange(e.target.value)}
        placeholder={t('settings.terminal.shortcuts.payloadPlaceholder')}
        spellCheck={false}
        className="h-9 min-w-0 flex-1 font-mono text-xs"
        data-testid="shortcut-manual-payload"
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onAdd}
        data-testid="shortcut-manual-add"
      >
        <Plus className="h-3.5 w-3.5" />
        {t('settings.terminal.shortcuts.add')}
      </Button>
    </div>
  );
}

function CaptureButton({ onAddSend }: { onAddSend: (label: string, payload: string) => void }) {
  const { t } = useTranslation();
  const [capturing, setCapturing] = useState(false);

  const onCaptureKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const seq = keyEventToTerminalSequence({
      key: e.key,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
    });
    if (seq) {
      onAddSend(seq.label, seq.payload);
      setCapturing(false);
    }
  };

  return (
    <button
      type="button"
      onKeyDown={onCaptureKeyDown}
      // Safari/WKWebView 桌面端点击 button 不赋予焦点，捕获态永远进不去——显式聚焦。
      onClick={(e) => e.currentTarget.focus()}
      onFocus={() => setCapturing(true)}
      onBlur={() => setCapturing(false)}
      className={cn(
        'w-full rounded-lg border px-3 py-2.5 text-center text-sm outline-none transition-colors',
        capturing
          ? 'border-primary bg-primary/5 text-foreground'
          : 'border-border text-muted-foreground'
      )}
      data-testid="shortcut-capture-input"
    >
      {capturing
        ? t('settings.terminal.shortcuts.capturePrompt')
        : t('settings.terminal.shortcuts.captureHint')}
    </button>
  );
}

export interface TerminalShortcutAddPanelProps {
  onAddSend: (label: string, payload: string) => void;
  onAddAction: (action: TerminalShortcutAction) => void;
}

/** 三个录入入口：按键捕获、特殊动作按钮、高级手填转义序列。 */
export function TerminalShortcutAddPanel({
  onAddSend,
  onAddAction,
}: TerminalShortcutAddPanelProps) {
  const { t } = useTranslation();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [manualLabel, setManualLabel] = useState('');
  const [manualPayload, setManualPayload] = useState('');

  const addManual = () => {
    const payload = parseEscapeSequence(manualPayload);
    if (!payload) return;
    onAddSend(manualLabel.trim(), payload);
    setManualLabel('');
    setManualPayload('');
  };

  return (
    <div className="space-y-3 rounded-lg border border-dashed border-border p-4">
      <span className="block font-medium text-sm">
        {t('settings.terminal.shortcuts.addShortcut')}
      </span>

      <CaptureButton onAddSend={onAddSend} />

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

      <button
        type="button"
        className="text-muted-foreground text-xs underline underline-offset-2"
        onClick={() => setAdvancedOpen((o) => !o)}
      >
        {t('settings.terminal.shortcuts.advanced')}
      </button>
      {advancedOpen && (
        <ManualEntry
          label={manualLabel}
          payload={manualPayload}
          onLabelChange={setManualLabel}
          onPayloadChange={setManualPayload}
          onAdd={addManual}
        />
      )}
    </div>
  );
}
