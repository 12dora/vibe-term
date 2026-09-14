// 本机卡的版式零件：四段共用的小节标题，与所有提示共用的一行式提醒。
//
// 提醒过去是四种背景色 + 各自的内联样式散在三个文件里，同一类问题在不同面板
// 长得不一样。这里收成一个组件：档位决定颜色，动作永远在右边，行高一致换档不跳版。

import { TONE_CLASS } from '@/lib/tone';
import { Button } from '@vibeterm/ui/button';
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

export type NoticeTone = 'danger' | 'warning' | 'muted' | 'primary';

// `primary` 不是问题档：它给「刚设置完，下一步在这里」这类需要被看见的陈述用。
const CARD_NOTICE_CLASS: Record<NoticeTone, string> = {
  danger: TONE_CLASS.cardNotice.blocked,
  warning: TONE_CLASS.cardNotice.warn,
  muted: TONE_CLASS.cardNotice.muted,
  primary: TONE_CLASS.notice.ok,
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
      className={`flex flex-wrap items-center gap-2 rounded-lg p-2 text-xs ${CARD_NOTICE_CLASS[tone]}`}
      data-testid={testId}
    >
      {spinner ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
      ) : (
        <ShieldAlert className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1">{children}</span>
      {/* 窄屏动作另起一行右对齐：挤在文字右边会把句子压成两三个字一行。 */}
      {action && <span className="flex w-full justify-end sm:w-auto">{action}</span>}
    </p>
  );
}

export function NoticeAction({
  label,
  testId,
  disabled = false,
  onClick,
  data,
}: {
  label: string;
  testId: string;
  disabled?: boolean;
  onClick: () => void;
  /** 额外的 `data-*` 抓手：「接入本机中继」要把预填地址带在按钮上。 */
  data?: Record<string, string>;
}) {
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      {...data}
    >
      {label}
    </Button>
  );
}
