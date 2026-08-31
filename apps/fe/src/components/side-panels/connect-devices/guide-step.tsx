// 接入指引的步骤卡：与远程访问向导同一套视觉（编号圆点 + 标题 + 说明）。
// 步骤默认是静态说明；能从本机现状判定「已做完」的那几步传 `state="done"`，圆点换成对勾。

import { NavLink } from '@/components/page-layouts/components/nav-link';
import { Check } from 'lucide-react';
import type { ReactNode } from 'react';

export type GuideStepState = 'todo' | 'done';

export function GuideStep({
  index,
  title,
  description,
  testId,
  state = 'todo',
  children,
}: {
  index: number;
  title: string;
  description?: string;
  testId: string;
  state?: GuideStepState;
  children?: ReactNode;
}) {
  const done = state === 'done';
  return (
    <section
      data-testid={testId}
      data-step-state={state}
      className={`rounded-xl bg-card p-3 ring-1 ${done ? 'ring-primary/30' : 'ring-foreground/10'}`}
    >
      <div className="flex items-start gap-2.5">
        <span
          data-testid={`${testId}-marker`}
          className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium ${
            done ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'
          }`}
        >
          {done ? <Check className="size-3" /> : index}
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="space-y-0.5">
            <h3 className="text-sm font-medium">{title}</h3>
            {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
          </div>
          {children}
        </div>
      </div>
    </section>
  );
}

/** 步骤卡里的一行说明：`warning` 用于需要用户警觉的结论（与设置页同一套琥珀色块）。 */
export function GuideNote({
  tone = 'muted',
  testId,
  children,
}: {
  tone?: 'muted' | 'warning';
  testId: string;
  children: ReactNode;
}) {
  const className =
    tone === 'warning'
      ? 'rounded-lg bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400'
      : 'text-xs text-muted-foreground';
  return (
    <p className={className} data-testid={testId}>
      {children}
    </p>
  );
}

/**
 * 指引里跳设置页的行内链接。走 NavLink 让 `/n/:nodeId` 边界下也指向本 node 的设置页；
 * 目标地址不带 `?panel=`，跳转时面板自然关闭。
 */
export function GuideLink({
  to,
  testId,
  children,
}: {
  to: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <NavLink to={to} className="text-primary underline underline-offset-2" data-testid={testId}>
      {children}
    </NavLink>
  );
}
