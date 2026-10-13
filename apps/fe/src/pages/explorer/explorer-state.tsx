// 标签页主体的占位状态（加载中 / 节点离线 / 未登录 / 节点或目录已不存在）：居中的图标 + 一行说明 + 可选操作。

import { cn } from '@vibeterm/ui';
import { Button } from '@vibeterm/ui/button';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export type ExplorerStateKind = 'loading' | 'offline' | 'signedOut' | 'nodeMissing' | 'rootMissing';

export function ExplorerStateScreen({
  kind,
  icon: Icon,
  text,
  spin = false,
  children,
}: {
  kind: ExplorerStateKind;
  icon: LucideIcon;
  /** 加载态只有图标 */
  text?: string;
  spin?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      data-testid={`explorer-state-${kind}`}
      role={kind === 'loading' ? 'status' : undefined}
      className="vibeterm-fade flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <Icon
        aria-hidden="true"
        strokeWidth={1.5}
        className={cn(
          'size-8 text-muted-foreground/70',
          spin && 'size-5 animate-spin motion-reduce:animate-none'
        )}
      />
      {text && <p className="max-w-xs text-muted-foreground text-sm">{text}</p>}
      {children}
    </div>
  );
}

export function CloseTabButton({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  return (
    <Button variant="outline" size="sm" onClick={onClose}>
      {t('explorer.state.closeTab')}
    </Button>
  );
}
