// 公网端口选择器：只改写公开地址里的端口一段。
//
// 80/443 被运营商封锁时，Hub / 中继得架在高位端口上，而地址栏里的端口一改，
// 反代或本机 HTTPS 监听也得跟着改——提示行说的就是这件事。
// 建议端口每次挂载抽一个，之后保持不变：抽来抽去会让用户以为端口是随机生成的。

import { pickSuggestedPort } from '@tmex/shared/net';
import { Input } from '@tmex/ui/input';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { readAddressPort, replaceAddressPort, splitAddress } from './address-probe';

const STANDARD_PORT = 443;
const MAX_PORT = 65535;

type PortMode = 'standard' | 'suggested' | 'custom';

const MODES: PortMode[] = ['standard', 'suggested', 'custom'];

export interface PortPickerProps {
  /** 与地址输入框同一份值：端口从中读出，也写回其中。 */
  url: string;
  onChange: (url: string) => void;
  /** 测试注入固定的建议端口。 */
  suggestedPort?: number;
  idPrefix: string;
}

/** 地址里已有的端口决定初始档位；自定义档另记一份，否则清空端口就跳回「标准」。 */
function modeOf(port: number | null, suggested: number, manualCustom: boolean): PortMode {
  if (manualCustom) return 'custom';
  if (port === null || port === STANDARD_PORT) return 'standard';
  return port === suggested ? 'suggested' : 'custom';
}

export function PortPicker({ url, onChange, suggestedPort, idPrefix }: PortPickerProps) {
  const { t } = useTranslation();
  const [suggested] = useState(() => suggestedPort ?? pickSuggestedPort());
  const [manualCustom, setManualCustom] = useState(false);
  const port = readAddressPort(url);
  const mode = modeOf(port, suggested, manualCustom);
  // 地址还拆不开（多半是空的）时无处可写端口：先填地址。
  const disabled = splitAddress(url) === null;

  function select(next: PortMode): void {
    setManualCustom(next === 'custom');
    if (next === 'standard') onChange(replaceAddressPort(url, null));
    if (next === 'suggested') onChange(replaceAddressPort(url, suggested));
  }

  function setCustom(raw: string): void {
    const value = Number(raw);
    if (!/^\d{1,5}$/.test(raw) || value < 1 || value > MAX_PORT) return;
    onChange(replaceAddressPort(url, value));
  }

  return (
    <div className="space-y-2">
      <span className="block text-sm font-medium">{t('nodes.setup.fields.publicPort')}</span>
      <div className="flex flex-wrap gap-2" role="radiogroup" data-testid={`${idPrefix}-port-mode`}>
        {MODES.map((option) => (
          <PortModeOption
            key={option}
            idPrefix={idPrefix}
            option={option}
            selected={mode === option}
            disabled={disabled}
            label={modeLabel(t, option, suggested)}
            onSelect={() => select(option)}
          />
        ))}
      </div>
      {mode === 'custom' && (
        <Input
          id={`${idPrefix}-port-custom`}
          data-testid={`${idPrefix}-port-custom`}
          inputMode="numeric"
          aria-label={t('nodes.setup.fields.publicPortValue')}
          defaultValue={port === null ? '' : String(port)}
          disabled={disabled}
          placeholder="1-65535"
          className="min-h-10 max-w-40"
          onChange={(event) => setCustom(event.target.value)}
        />
      )}
      <p className="text-xs text-muted-foreground">{t('nodes.setup.fields.publicPortHint')}</p>
    </div>
  );
}

function modeLabel(
  t: (key: string, options?: Record<string, unknown>) => string,
  option: PortMode,
  suggested: number
): string {
  if (option === 'standard') return t('nodes.setup.fields.publicPortStandard');
  if (option === 'suggested')
    return t('nodes.setup.fields.publicPortSuggested', { port: suggested });
  return t('nodes.setup.fields.publicPortCustom');
}

function PortModeOption({
  idPrefix,
  option,
  selected,
  disabled,
  label,
  onSelect,
}: {
  idPrefix: string;
  option: PortMode;
  selected: boolean;
  disabled: boolean;
  label: string;
  onSelect: () => void;
}) {
  return (
    <label
      data-testid={`${idPrefix}-port-${option}`}
      data-selected={selected ? 'true' : 'false'}
      className={`cursor-pointer rounded-lg px-3 py-1.5 text-xs ring-1 transition-colors ${
        selected ? 'bg-primary/5 ring-primary' : 'bg-card ring-foreground/10 hover:bg-muted/50'
      } ${disabled ? 'pointer-events-none opacity-50' : ''}`}
    >
      <input
        type="radio"
        name={`${idPrefix}-port-mode`}
        className="sr-only"
        checked={selected}
        disabled={disabled}
        onChange={onSelect}
      />
      {label}
    </label>
  );
}
