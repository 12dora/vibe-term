// 节点设置里的共享小部件：标签行、事实串、复制状态与可访问的复制反馈。
//
// 播报区里**只能**放「已复制」：把可见标签整段塞进 live region 的话，2 秒后复位会让
// 「复制」变成一条新内容再播一次，读屏用户听到的是一句莫名其妙的第二次提示。
// 可见标签因此留在 live region 外面。

import { cn } from '@vibeterm/ui';
import { Button } from '@vibeterm/ui/button';
import { Check, Copy } from 'lucide-react';
import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * 「标签 + 值」的一行：本机卡里每一条事实都用这一个版式，标签列定宽、值列自适应。
 * 两列版式在任何宽度下都保留——手机上把标签摞到值上面，整张卡就成了一张长表单；
 * 窄屏只把标签列收到 5.5rem，标签本身超宽时截断。
 */
export function Row({
  label,
  children,
  testId,
}: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div
      className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 text-xs sm:grid-cols-[6.5rem_minmax(0,1fr)]"
      data-testid={testId}
    >
      <span className="truncate text-muted-foreground" title={label}>
        {label}
      </span>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 break-words">
        {children}
      </div>
    </div>
  );
}

export type SegmentItem = { key: string; node: ReactNode };

/**
 * 一串并列的事实：宽屏用 `·` 串成一句，窄屏（< sm）逐条堆叠且不摆分隔符。
 * 手机上长串只会在段中间折行，读起来像断错了句；堆叠之后每段各占一行，天然对齐。
 */
export function Segments({
  items,
  className,
  testId,
}: { items: SegmentItem[]; className?: string; testId?: string }) {
  return (
    <span
      className={cn(
        'flex min-w-0 flex-col gap-y-0.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-1.5',
        className
      )}
      data-testid={testId}
    >
      {items.map((item, index) => (
        <Fragment key={item.key}>
          {index > 0 && (
            <span className="hidden text-muted-foreground/60 sm:inline" aria-hidden>
              ·
            </span>
          )}
          {item.node}
        </Fragment>
      ))}
    </span>
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

/**
 * 按钮里的可见标签 + 常驻的 sr-only 播报节点。
 * `compact` 在窄屏收起可见标签（按钮只剩图标）：手机上那两个字换来的是地址被截掉一截。
 */
export function CopyLabel({ copied, compact = false }: { copied: boolean; compact?: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      <span className={compact ? 'hidden sm:inline' : undefined}>
        {copied ? t('nodes.actions.copied') : t('nodes.actions.copy')}
      </span>
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
  const { t } = useTranslation();
  const { copied, copy } = useCopyToClipboard(value);
  return (
    <Button
      type="button"
      size="xs"
      variant={variant}
      // 窄屏只剩图标，按钮名字改由 `aria-label` 兜住。
      aria-label={copied ? t('nodes.actions.copied') : t('nodes.actions.copy')}
      onClick={copy}
      data-testid={`${testId}-copy`}
    >
      {copied ? <Check className="vibeterm-scale-in" /> : <Copy className="vibeterm-scale-in" />}
      <CopyLabel copied={copied} compact />
    </Button>
  );
}

// 截断而不是 `break-all`：手机上一条地址折成两三行之后，同一行里的徽标会被挤到第三行去。
// 完整值一直在 `title` 与复制按钮里。
const VALUE_CODE_CLASS = 'min-w-0 truncate rounded bg-muted/50 px-1.5 py-0.5 text-[11px]';

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
        title={value}
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
