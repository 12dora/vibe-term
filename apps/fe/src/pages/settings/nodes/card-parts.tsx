// 本机卡的版式零件：四段共用的小节标题，与所有提示共用的一行式提醒。
//
// 提醒过去是四种背景色 + 各自的内联样式散在三个文件里，同一类问题在 hub 面板与中继面板
// 长得不一样。这里收成一个组件：档位决定颜色，动作永远在右边，行高一致换档不跳版。

import { Button } from '@tmex/ui/button';
import { Loader2, ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';

export function CardSection({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3" data-testid={testId}>
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

export type NoticeTone = 'danger' | 'warning' | 'muted';

const NOTICE_CLASS: Record<NoticeTone, string> = {
  danger: 'bg-destructive/10 text-destructive',
  warning: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  muted: 'bg-muted/60 text-muted-foreground',
};

export function Notice({
  tone,
  testId,
  spinner = false,
  children,
  action,
}: {
  tone: NoticeTone;
  testId: string;
  /** 「还在连」这一档用转圈代替警示图标：它不是问题，只是还没有结论。 */
  spinner?: boolean;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <p
      className={`flex flex-wrap items-center gap-2 rounded-lg p-2 text-xs ${NOTICE_CLASS[tone]}`}
      data-testid={testId}
    >
      {spinner ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
      ) : (
        <ShieldAlert className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </p>
  );
}

export function NoticeAction({
  label,
  testId,
  disabled = false,
  onClick,
}: {
  label: string;
  testId: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
    >
      {label}
    </Button>
  );
}
