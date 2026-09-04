// 带「生成」按钮的口令输入框：中继接入口令、首个账号密码、运营者改口令三处共用。
//
// 口令是给别人抄走的东西，不是给人记的：默认生成一串足够长的随机串，用户想自己填也随时能改。
// 字母表去掉了 0/O、1/l/I 这些抄写时会认错的字符——口令多半要口头或截图传给另一台机器。

import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { Check, Copy, Eye, EyeOff, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** 去掉 0/O、1/l/I 的易混字符表。 */
export const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export const GENERATED_PASSWORD_LENGTH = 20;

const COPIED_RESET_MS = 2000;

/**
 * 生成随机口令。
 *
 * 用拒绝采样而不是 `% 字母表长度`：256 不是 56 的整数倍，直接取模会让前 32 个字符
 * 的出现概率高出约 14%，白白削掉熵。
 */
export function generatePassword(length: number = GENERATED_PASSWORD_LENGTH): string {
  const bound = PASSWORD_ALPHABET.length;
  const limit = 256 - (256 % bound);
  const out: string[] = [];
  const bytes = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (out.length === length) break;
      if (byte < limit) out.push(PASSWORD_ALPHABET[byte % bound] as string);
    }
  }
  return out.join('');
}

/** 只在字段还空着时自动生成：用户手填过的值绝不覆盖。 */
export function shouldAutoGenerate(defaultGenerate: boolean, value: string): boolean {
  return defaultGenerate && value.length === 0;
}

export interface PasswordFieldWithGenerateProps {
  id: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  autoComplete?: string;
  placeholder?: string;
  /** 挂载时字段为空就先生成一个。 */
  defaultGenerate?: boolean;
  /** 显示 / 隐藏切换，默认有。 */
  revealToggle?: boolean;
}

export function PasswordFieldWithGenerate({
  id,
  value,
  onChange,
  disabled = false,
  autoComplete = 'new-password',
  placeholder,
  defaultGenerate = false,
  revealToggle = true,
}: PasswordFieldWithGenerateProps) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);
  const generated = useRef(false);

  useEffect(() => {
    if (generated.current) return;
    generated.current = true;
    if (shouldAutoGenerate(defaultGenerate, value)) onChange(generatePassword());
  }, [defaultGenerate, value, onChange]);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Input
        id={id}
        type={revealed ? 'text' : 'password'}
        value={value}
        disabled={disabled}
        autoComplete={autoComplete}
        placeholder={placeholder}
        className="min-h-10 min-w-0 flex-1 font-mono"
        onChange={(event) => onChange(event.target.value)}
        data-testid={id}
      />
      {revealToggle && (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={disabled}
          aria-label={t(revealed ? 'nodes.setup.password.hide' : 'nodes.setup.password.show')}
          onClick={() => setRevealed((previous) => !previous)}
          data-testid={`${id}-reveal`}
        >
          {revealed ? <EyeOff /> : <Eye />}
        </Button>
      )}
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={disabled}
        onClick={() => onChange(generatePassword())}
        data-testid={`${id}-generate`}
      >
        <RefreshCw />
        {t('nodes.setup.password.generate')}
      </Button>
      {value.length > 0 && <CopyValueButton value={value} testId={`${id}-copy`} />}
    </div>
  );
}

function CopyValueButton({ value, testId }: { value: string; testId: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );

  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    });
  }, [value]);

  return (
    <Button type="button" size="xs" variant="ghost" onClick={copy} data-testid={testId}>
      {copied ? <Check className="tmex-scale-in" /> : <Copy className="tmex-scale-in" />}
      <span>{t(copied ? 'nodes.actions.copied' : 'nodes.actions.copy')}</span>
      <output className="sr-only" aria-live="polite">
        {copied ? t('nodes.actions.copied') : ''}
      </output>
    </Button>
  );
}
