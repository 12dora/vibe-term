import type { ReactNode } from 'react';

export interface RowLabelProps {
  title: ReactNode;
  /** 进程名（可选拼上 cwd）；缺省时只渲染标题行 */
  subtitle?: ReactNode;
}

/** 窗口行与 pane 行共用的两行文本：标题 + 进程@路径 */
export function RowLabel({ title, subtitle }: RowLabelProps) {
  return (
    <span className="flex-1 min-w-0">
      <span className="font-mono text-[11px] leading-tight font-medium line-clamp-2 [overflow-wrap:break-word]">
        {title}
      </span>
      {subtitle && (
        <span className="font-mono text-[10.5px] leading-tight text-muted-foreground line-clamp-1 break-all">
          {subtitle}
        </span>
      )}
    </span>
  );
}

/** `process@cwd`；无 cwd 时退化成裸进程名，无进程名时不渲染副标题 */
export function processSubtitle(process?: string | null, cwd?: string | null): string | undefined {
  if (!process) return undefined;
  return cwd ? `${process}@${cwd}` : process;
}
