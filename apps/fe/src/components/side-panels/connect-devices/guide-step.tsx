// 接入指引的步骤卡：与远程访问向导同一套视觉（编号圆点 + 标题 + 说明），
// 但这里的步骤是静态说明，没有待办 / 已完成状态。

import { NavLink } from '@/components/page-layouts/components/nav-link';
import type { ReactNode } from 'react';

export function GuideStep({
  index,
  title,
  description,
  testId,
  children,
}: {
  index: number;
  title: string;
  description?: string;
  testId: string;
  children?: ReactNode;
}) {
  return (
    <section data-testid={testId} className="rounded-xl bg-card p-3 ring-1 ring-foreground/10">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
          {index}
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
