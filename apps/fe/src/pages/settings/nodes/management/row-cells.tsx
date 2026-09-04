// 节点表的通用单元格与「不可写」提示：正常行与待批准行共用，放这里避免两个行组件互相 import。

import { cn } from '@tmex/ui';
import type { NodeActionDeps } from './types';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={cn('whitespace-nowrap px-3 py-2 text-left font-medium', className)}>
      {children}
    </th>
  );
}

export function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn('whitespace-nowrap px-3 py-2 align-middle', className)}>{children}</td>;
}

export function Tag({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span
      className="rounded border border-border px-1 py-px text-[10px] text-muted-foreground"
      title={title}
    >
      {children}
    </span>
  );
}

/**
 * 不可写时的提示。调用方给了原因就用它（中继模式下上级不是 hub，说「Hub 不可达」是错的），
 * 否则按 hub 的两种情形分档：备 Hub 拒写 / 主 Hub 不可达。
 */
export function rowBlockedHint(
  t: Translate,
  deps: Pick<NodeActionDeps, 'hubWritable' | 'blockedHint'>
): string {
  if (deps.blockedHint) return deps.blockedHint;
  return t(deps.hubWritable ? 'nodes.hubOffline' : 'nodes.hubs.standbyNotice');
}
