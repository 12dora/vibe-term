// 公网端口选择器：只改写公开地址里的端口一段。
//
// 80/443 被运营商封锁时，Hub / 中继得架在高位端口上，而地址栏里的端口一改，
// 反代或本机 HTTPS 监听也得跟着改——提示行说的就是这件事。
// 建议端口每次挂载抽一个，之后保持不变：抽来抽去会让用户以为端口是随机生成的。

import { pickSuggestedPort } from '@vibeterm/shared/net';
import { Input } from '@vibeterm/ui/input';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { readAddressPort, replaceAddressPort, splitAddress } from './address-probe';

const STANDARD_PORT = 443;
const MAX_PORT = 65535;
const PORT_ERROR_KEY = 'nodes.setup.errors.invalid_port';

export type PortMode = 'standard' | 'suggested' | 'custom';

const MODES: PortMode[] = ['standard', 'suggested', 'custom'];

export interface PortPickerProps {
  /** 与地址输入框同一份值：端口从中读出，也写回其中。 */
  url: string;
  /**
   * 端口一改就回调。`error` 非空表示自定义端口填得不对（空或越界）：
   * 此时地址里的端口**没有**被改写，调用方必须据此拦住提交，
   * 否则界面显示的是一个端口、提交出去的是上一个端口。
   */
  onChange: (url: string, error: string | null) => void;
  /** 测试注入固定的建议端口。 */
  suggestedPort?: number;
  idPrefix: string;
}

/** 地址里已有的端口决定初始档位；自定义档另记一份，否则清空端口就跳回「标准」。 */
export function modeOf(port: number | null, suggested: number, manualCustom: boolean): PortMode {
  if (manualCustom) return 'custom';
  if (port === null || port === STANDARD_PORT) return 'standard';
  return port === suggested ? 'suggested' : 'custom';
}

/** 合法端口返回数字，空串与越界返回 null。 */
export function parsePort(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 1 && value <= MAX_PORT ? value : null;
}

export interface PortChange {
  url: string;
  /** 非空表示这次改动没落到地址里，调用方必须据此拦住提交。 */
  error: string | null;
}

/**
 * 自定义端口的每一次击键。填坏了（空、非数字、越界）就**不动地址**，只报错——
 * 悄悄沿用上一个端口会让界面显示的端口与提交出去的端口对不上。
 */
export function customPortChange(url: string, raw: string): PortChange {
  const value = parsePort(raw);
  if (value === null) return { url, error: PORT_ERROR_KEY };
  return { url: replaceAddressPort(url, value), error: null };
}

/** 切档位：标准清掉端口，建议写建议端口，自定义沿用当前草稿（草稿不合法即为待修错误）。 */
export function modeChange(
  url: string,
  next: PortMode,
  suggested: number,
  draft: string
): PortChange {
  if (next === 'standard') return { url: replaceAddressPort(url, null), error: null };
  if (next === 'suggested') return { url: replaceAddressPort(url, suggested), error: null };
  return { url, error: parsePort(draft) === null ? PORT_ERROR_KEY : null };
}

export function PortPicker({ url, onChange, suggestedPort, idPrefix }: PortPickerProps) {
  const { t } = useTranslation();
  const [suggested] = useState(() => suggestedPort ?? pickSuggestedPort());
  const [manualCustom, setManualCustom] = useState(false);
  const port = readAddressPort(url);
  // 输入框是受控的：地址那头改了端口，这里必须跟着显示，否则显示与提交会对不上。
  const [draft, setDraft] = useState(() => (port === null ? '' : String(port)));
  useEffect(() => {
    setDraft(port === null ? '' : String(port));
    // 端口是从地址那头改的：档位重新按地址推断，别把「自定义」这个记号留成孤儿状态。
    setManualCustom(false);
  }, [port]);
  const mode = modeOf(port, suggested, manualCustom);
  // 地址还拆不开（多半是空的）时无处可写端口：先填地址。
  const disabled = splitAddress(url) === null;
  const draftError = mode === 'custom' && parsePort(draft) === null ? PORT_ERROR_KEY : null;

  function select(next: PortMode): void {
    setManualCustom(next === 'custom');
    const change = modeChange(url, next, suggested, draft);
    onChange(change.url, change.error);
  }

  function setCustom(raw: string): void {
    setDraft(raw);
    const change = customPortChange(url, raw);
    onChange(change.url, change.error);
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
          value={draft}
          disabled={disabled}
          placeholder="1-65535"
          className="min-h-10 max-w-40"
          onChange={(event) => setCustom(event.target.value)}
        />
      )}
      {draftError && !disabled ? (
        <p className="text-xs text-destructive" data-testid={`${idPrefix}-port-error`}>
          {t(draftError)}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">{t('nodes.setup.fields.publicPortHint')}</p>
      )}
    </div>
  );
}

function modeLabel(
  t: (key: string, options?: Record<string, unknown>) => string,
  option: PortMode,
  suggested: number
): string {
  if (option === 'standard') return t('nodes.setup.fields.publicPortStandard');
  if (option === 'suggested') {
    return t('nodes.setup.fields.publicPortSuggested', { port: suggested });
  }
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
