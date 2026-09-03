// 节点设置里的共享小部件：标签行、复制状态与可访问的复制反馈。
//
// 播报区里**只能**放「已复制」：把可见标签整段塞进 live region 的话，2 秒后复位会让
// 「复制」变成一条新内容再播一次，读屏用户听到的是一句莫名其妙的第二次提示。
// 可见标签因此留在 live region 外面。

import { Button } from '@tmex/ui/button';
import { Check, Copy } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** 「标签 + 内容」的一行：本机区块里所有条目共用这个左侧固定宽度。 */
export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-32 shrink-0 text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

export const COPIED_RESET_MS = 2000;

export function useCopyToClipboard(value: string) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    []
  );

  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    });
  }, [value]);

  return { copied, copy };
}

/** 按钮里的可见标签 + 常驻的 sr-only 播报节点。 */
export function CopyLabel({ copied }: { copied: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      <span>{copied ? t('nodes.actions.copied') : t('nodes.actions.copy')}</span>
      <output className="sr-only" aria-live="polite">
        {copied ? t('nodes.actions.copied') : ''}
      </output>
    </>
  );
}

/** 复制按钮：图标随复制状态切换，标签自带播报节点。 */
export function CopyButton({
  value,
  testId,
  variant = 'ghost',
}: {
  value: string;
  testId: string;
  variant?: 'ghost' | 'outline';
}) {
  const { copied, copy } = useCopyToClipboard(value);
  return (
    <Button type="button" size="xs" variant={variant} onClick={copy} data-testid={`${testId}-copy`}>
      {copied ? <Check className="tmex-scale-in" /> : <Copy className="tmex-scale-in" />}
      <CopyLabel copied={copied} />
    </Button>
  );
}

const VALUE_CODE_CLASS = 'min-w-0 break-all rounded bg-muted/50 px-1.5 py-0.5 text-[11px]';

/** 只读的地址 / 标识：行内等宽展示 + 一键复制。`mono` 给需要强制等宽的调用点（https 区块）。 */
export function CopyableValue({
  value,
  testId,
  mono = false,
}: { value: string; testId: string; mono?: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <code
        className={mono ? `${VALUE_CODE_CLASS} font-mono` : VALUE_CODE_CLASS}
        data-testid={testId}
      >
        {value}
      </code>
      <CopyButton value={value} testId={testId} />
    </span>
  );
}

/** 带标题的整块内容（join 命令 / 加入码）：上下两行排版 + 一键复制。 */
export function CopyableCode({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <div className="flex items-start gap-1">
        <code
          className="min-w-0 flex-1 break-all rounded bg-background p-2 text-[11px]"
          data-testid={testId}
        >
          {value}
        </code>
        <CopyButton value={value} testId={testId} variant="outline" />
      </div>
    </div>
  );
}
