// 分享两张表共用的单元格与空状态。列宽与滚动壳见 `../components/wide-table`。

import { cn } from '@tmex/ui';
import type { ReactNode } from 'react';

export function Th({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <th className={cn('whitespace-nowrap px-3 py-2 text-left font-medium', className)}>
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
  title,
  testId,
}: { children: ReactNode; className?: string; title?: string; testId?: string }) {
  return (
    <td
      className={cn('whitespace-nowrap px-3 py-2 align-middle', className)}
      title={title}
      data-testid={testId}
    >
      {children}
    </td>
  );
}

export function EmptyRow({
  colSpan,
  testId,
  children,
}: { colSpan: number; testId: string; children: ReactNode }) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        className="tmex-fade px-3 py-6 text-center text-muted-foreground"
        data-testid={testId}
      >
        {children}
      </td>
    </tr>
  );
}

/** 相对时间 + 绝对时间 tooltip。 */
export function TimeCell({ text, title }: { text: string; title: string }) {
  return <span title={title}>{text}</span>;
}
