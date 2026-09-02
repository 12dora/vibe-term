// HTTPS 模式四选一。选中只切换下方表单，真正落库要按各表单里的保存。

import type { TlsMode } from '@tmex/api-client/local/tls-types';
import { Cloud, Globe, ShieldCheck, ShieldOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

const MODES: { mode: TlsMode; icon: ReactNode }[] = [
  { mode: 'external', icon: <Globe className="size-4" /> },
  { mode: 'selfsigned', icon: <ShieldCheck className="size-4" /> },
  { mode: 'acme', icon: <Cloud className="size-4" /> },
  { mode: 'none', icon: <ShieldOff className="size-4" /> },
];

export function ModeChooser({
  selected,
  active,
  disabled,
  onSelect,
}: {
  /** 当前正在编辑的模式。 */
  selected: TlsMode;
  /** 后端当前生效的模式，用于标注「生效中」。 */
  active: TlsMode;
  disabled: boolean;
  onSelect: (mode: TlsMode) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="grid gap-3 sm:grid-cols-2"
      role="radiogroup"
      aria-label={t('nodes.https.status.mode')}
      data-testid="https-mode-chooser"
    >
      {MODES.map(({ mode, icon }) => (
        <label
          key={mode}
          data-testid={`https-mode-${mode}`}
          data-selected={selected === mode ? 'true' : 'false'}
          className={`flex cursor-pointer flex-col gap-1.5 rounded-xl p-3 text-left ring-1 transition-colors ${
            selected === mode
              ? 'bg-primary/5 ring-primary'
              : 'bg-card ring-foreground/10 hover:bg-muted/50'
          } ${disabled ? 'pointer-events-none opacity-60' : ''}`}
        >
          <input
            type="radio"
            name="https-mode"
            data-testid={`https-mode-${mode}-input`}
            className="sr-only"
            checked={selected === mode}
            disabled={disabled}
            onChange={() => onSelect(mode)}
          />
          <span className="flex items-center gap-2 text-sm font-medium">
            {icon}
            {t(`nodes.https.mode.${mode}.title`)}
            {active === mode && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                {t('nodes.https.modeActive')}
              </span>
            )}
          </span>
          <span className="text-xs text-muted-foreground">
            {t(`nodes.https.mode.${mode}.description`)}
          </span>
        </label>
      ))}
    </div>
  );
}
