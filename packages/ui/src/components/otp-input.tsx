'use client';

import * as React from 'react';

import { cn } from '../utils';

export const OTP_DEFAULT_LENGTH = 6;

/** 一次编辑的结果：规范化后的完整验证码 + 编辑后应该聚焦的格子下标。 */
export interface OtpEdit {
  value: string;
  caret: number;
}

/** 只保留数字：空格、连字符等分隔符直接丢掉，超长部分截断。 */
export function sanitizeOtp(raw: string, length: number = OTP_DEFAULT_LENGTH): string {
  return raw.replace(/\D/g, '').slice(0, length);
}

/**
 * 可聚焦的格子范围是 `[0, min(已填长度, length - 1)]`：
 * 空码只能停在第一格，填满后才能停到最后一格，中间不会出现跳过的空洞。
 */
export function clampOtpIndex(
  value: string,
  index: number,
  length: number = OTP_DEFAULT_LENGTH
): number {
  const max = Math.min(value.length, length - 1);
  return Math.max(0, Math.min(index, max));
}

export function moveOtpIndex(
  value: string,
  index: number,
  delta: number,
  length: number = OTP_DEFAULT_LENGTH
): number {
  return clampOtpIndex(value, index + delta, length);
}

/**
 * 从 `index` 起写入若干位（单键输入与整串粘贴 / 自动填充走同一条路径：
 * `autocomplete="one-time-code"` 会把整串塞进当前聚焦的那一格）。
 * 覆盖写而非插入——OTP 每一格是定位的，不该把后面的位往右挤。
 */
export function applyOtpInsert(
  value: string,
  index: number,
  raw: string,
  length: number = OTP_DEFAULT_LENGTH
): OtpEdit {
  const at = clampOtpIndex(value, index, length);
  const digits = sanitizeOtp(raw, length - at);
  if (!digits) return { value, caret: at };
  const next = (value.slice(0, at) + digits + value.slice(at + digits.length)).slice(0, length);
  return { value: next, caret: clampOtpIndex(next, at + digits.length, length) };
}

/** Backspace：当前格有值就删当前格；当前格是空的则退到前一格并删掉它。 */
export function applyOtpBackspace(
  value: string,
  index: number,
  length: number = OTP_DEFAULT_LENGTH
): OtpEdit {
  const at = clampOtpIndex(value, index, length);
  if (at < value.length) {
    const next = value.slice(0, at) + value.slice(at + 1);
    return { value: next, caret: clampOtpIndex(next, at, length) };
  }
  if (at <= 0) return { value, caret: 0 };
  const next = value.slice(0, at - 1) + value.slice(at);
  return { value: next, caret: clampOtpIndex(next, at - 1, length) };
}

/** Delete：删当前格，光标不动。 */
export function applyOtpDelete(
  value: string,
  index: number,
  length: number = OTP_DEFAULT_LENGTH
): OtpEdit {
  const at = clampOtpIndex(value, index, length);
  if (at >= value.length) return { value, caret: at };
  const next = value.slice(0, at) + value.slice(at + 1);
  return { value: next, caret: clampOtpIndex(next, at, length) };
}

/**
 * 受控单格输入里 `target.value` 可能是「原有字符 + 新键入字符」（光标没落在选中态时），
 * 这里把真正新增的那一位摘出来。只处理恰好多一位的情形——多出两位以上是
 * 粘贴 / 自动填充，整串原样交给 `applyOtpInsert` 处理。
 */
export function extractOtpInput(raw: string, current: string): string {
  if (!current || raw.length !== current.length + 1) return raw;
  if (raw.startsWith(current)) return raw.slice(current.length);
  if (raw.endsWith(current)) return raw.slice(0, raw.length - current.length);
  return raw;
}

export interface OtpInputProps
  extends Omit<React.ComponentProps<'fieldset'>, 'onChange' | 'children' | 'defaultValue'> {
  value: string;
  onChange: (value: string) => void;
  length?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  /** 每一格的 `aria-label`；不给则退化为 `1 / 6` 这样的纯数字标签。 */
  digitLabel?: (index: number, length: number) => string;
  inputClassName?: string;
  'data-testid'?: string;
}

/**
 * 一次性验证码输入：`length` 个单字符格子。
 * 值对外始终是一串纯数字（长度 ≤ `length`），格子只是它的可视切分。
 */
function OtpInput({
  value,
  onChange,
  length = OTP_DEFAULT_LENGTH,
  disabled,
  autoFocus,
  digitLabel,
  className,
  inputClassName,
  'data-testid': testId,
  ...props
}: OtpInputProps) {
  const refs = React.useRef<(HTMLInputElement | null)[]>([]);
  const normalized = sanitizeOtp(value, length);

  const focusSlot = React.useCallback((index: number) => {
    const el = refs.current[index];
    if (!el) return;
    el.focus();
    el.select?.();
  }, []);

  const commit = React.useCallback(
    (edit: OtpEdit) => {
      if (edit.value !== normalized) onChange(edit.value);
      focusSlot(edit.caret);
    },
    [focusSlot, normalized, onChange]
  );

  const handleChange = (index: number) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const current = normalized[index] ?? '';
    const typed = extractOtpInput(event.target.value, current);
    const edit = applyOtpInsert(normalized, index, typed, length);
    // 值没变（例如敲了个字母）时 React 不会重渲染，DOM 里那个非法字符要手动抹掉。
    if (edit.value === normalized) event.target.value = current;
    commit(edit);
  };

  const handleKeyDown = (index: number) => (event: React.KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'Backspace':
        event.preventDefault();
        commit(applyOtpBackspace(normalized, index, length));
        break;
      case 'Delete':
        event.preventDefault();
        commit(applyOtpDelete(normalized, index, length));
        break;
      case 'ArrowLeft':
        event.preventDefault();
        focusSlot(moveOtpIndex(normalized, index, -1, length));
        break;
      case 'ArrowRight':
        event.preventDefault();
        focusSlot(moveOtpIndex(normalized, index, 1, length));
        break;
      case 'Home':
        event.preventDefault();
        focusSlot(0);
        break;
      case 'End':
        event.preventDefault();
        focusSlot(clampOtpIndex(normalized, length - 1, length));
        break;
      default:
        break;
    }
  };

  const handlePaste = (index: number) => (event: React.ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    const text = event.clipboardData?.getData('text') ?? '';
    commit(applyOtpInsert(normalized, index, text, length));
  };

  // fieldset 而不是 div+role=group：读屏能把 aria-labelledby 的标题当成整组的名字念出来。
  return (
    <fieldset
      data-slot="otp-input"
      className={cn('flex min-w-0 items-center gap-1.5', className)}
      data-testid={testId}
      {...props}
    >
      {Array.from({ length }, (_, index) => (
        <input
          // biome-ignore lint/suspicious/noArrayIndexKey: 格子数固定、永不重排，下标就是身份
          key={index}
          ref={(el) => {
            refs.current[index] = el;
          }}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          // 只有第一格声明 one-time-code：多格都声明会让浏览器重复填充。
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          // 系统自动填充会把整串塞进一格，maxLength=1 会截断，这里放开由逻辑层截。
          maxLength={length}
          // biome-ignore lint/a11y/noAutofocus: 验证码框展开时按需自动聚焦是这个控件的固有交互
          autoFocus={autoFocus && index === 0}
          disabled={disabled}
          aria-label={digitLabel ? digitLabel(index, length) : `${index + 1} / ${length}`}
          value={normalized[index] ?? ''}
          data-testid={testId ? `${testId}-${index}` : undefined}
          onChange={handleChange(index)}
          onKeyDown={handleKeyDown(index)}
          onPaste={handlePaste(index)}
          onFocus={(event) => event.currentTarget.select()}
          className={cn(
            'dark:bg-input/30 border-input focus-visible:border-ring focus-visible:ring-ring/30 h-10 w-9 rounded-lg border bg-transparent text-center font-mono text-base tabular-nums transition-colors duration-(--tmex-motion-fast) ease-out outline-none focus-visible:ring-2 motion-reduce:transition-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
            inputClassName
          )}
        />
      ))}
    </fieldset>
  );
}

export { OtpInput };
