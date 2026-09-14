// 窄屏记录卡：宽表在 sm 以下换成的版式。
//
// 一张卡 = 标题行（勾选 / 名称 / 标记 / ⋯ 菜单）+ 若干条弱化信息行 + 末尾的主动作。
// 卡片与表格共用同一批 testid，调用方按 `useNarrowLayout()` 二选一渲染。

import { cn } from '@vibeterm/ui';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';

/** 整张卡可点选（点行筛选那一类）。卡内的按钮 / 输入框自成一体，点它们不切换选中。 */
export interface RecordCardSelection {
  selected: boolean;
  /** 悬浮提示，说明点一下会发生什么。 */
  hint?: string;
  onSelect: () => void;
}

export function RecordCardList({
  children,
  testId,
  className,
}: { children: ReactNode; testId?: string; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)} data-testid={testId}>
      {children}
    </div>
  );
}

export function RecordCard({
  children,
  testId,
  className,
  selection,
  dataOnline,
}: {
  children: ReactNode;
  testId?: string;
  className?: string;
  selection?: RecordCardSelection;
  dataOnline?: boolean;
}) {
  const onClick = (event: MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button, input, a')) return;
    selection?.onSelect();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    selection?.onSelect();
  };

  return (
    <article
      className={cn(
        'flex flex-col gap-1.5 rounded-lg border border-border/60 px-2.5 py-2 text-xs',
        selection && 'cursor-pointer hover:bg-muted/40',
        selection?.selected && 'bg-primary/5 ring-1 ring-primary/40 ring-inset hover:bg-primary/5',
        className
      )}
      aria-selected={selection ? selection.selected : undefined}
      tabIndex={selection ? 0 : undefined}
      title={selection?.hint}
      onClick={selection ? onClick : undefined}
      onKeyDown={selection ? onKeyDown : undefined}
      data-selected={selection?.selected ? '' : undefined}
      data-online={dataOnline ? '' : undefined}
      data-testid={testId}
    >
      {children}
    </article>
  );
}

/** 标题行：左边一串（勾选 / 名称 / 标记）占满，右边留给动作。 */
export function RecordCardTitle({
  children,
  actions,
}: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  );
}

/**
 * 段与段之间的 `·`。挂在前一段的 `::after` 上而不是后一段的 `::before`：
 * 一行放不下时分隔符跟着上一段留在行尾，不会变成下一行开头那个没人要的点。
 * 用 CSS 而不是在数组里插分隔符，省掉一串只为分隔符存在的 key。
 */
const SEGMENT_ROW =
  "flex flex-wrap items-center gap-x-1.5 gap-y-0.5 [&>*:not(:last-child)]:after:ml-1.5 [&>*:not(:last-child)]:after:content-['·']";

/** 弱化信息行：一串并列的事实，空值由调用方自己判空后不传。 */
export function RecordCardMeta({
  children,
  className,
}: { children: ReactNode; className?: string }) {
  return (
    <div className={cn(SEGMENT_ROW, 'text-[11px] text-muted-foreground', className)}>
      {children}
    </div>
  );
}

/**
 * 「标签 + 若干并列事实」的一行：标签后面不摆分隔符，事实之间才摆。
 * 一行只放两三段短的，390px 下就不会折行折出半句话。
 */
export function RecordCardFacts({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
      <span className="shrink-0">{label}</span>
      <span className={cn(SEGMENT_ROW, 'min-w-0 flex-1')}>{children}</span>
    </div>
  );
}

/** 一条「标签：值」行；标签列窄且值可换行，390px 下也不会把值挤成一列竖字。 */
export function RecordCardField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

export function RecordCardEmpty({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p
      className="vibeterm-fade px-3 py-6 text-center text-xs text-muted-foreground"
      data-testid={testId}
    >
      {children}
    </p>
  );
}
