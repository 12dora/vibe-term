// 二次确认框：标题 + 正文 + 「取消 / 确认」两个按钮。
//
// 原先 fe（域名访问、直连插件、停 https、移除隧道、踢租户、纯中继、切换中继）与 panels
// （刷新页面、关闭窗格）各自拼一遍同一套 AlertDialog 骨架，差别只在文案、按钮样式与 testId。
// 确认按钮默认按破坏性操作渲染；testId 逐个显式传：历史上 `-ok` / `-confirm` / `-cancel`
// 几种后缀并存，e2e 与单测都在断言这些名字，不能顺手统一。

import type { ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from './alert-dialog';

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  /** 正文，放进 `AlertDialogDescription`。 */
  children: ReactNode;
  cancelLabel: ReactNode;
  confirmLabel: ReactNode;
  onConfirm: () => void;
  /** 点「取消」时额外要做的事；不传就只靠 `onOpenChange` 关闭。 */
  onCancel?: () => void;
  /** 接管 open 变化（Esc / 点外面 / 取消）；不传则关闭时回调 `onCancel`。 */
  onOpenChange?: (open: boolean) => void;
  /** 确认按钮样式；非破坏性操作传 `'default'`。 */
  variant?: 'default' | 'destructive';
  /** 标题上方的图标块。 */
  media?: ReactNode;
  cancelDisabled?: boolean;
  confirmDisabled?: boolean;
  /** 内容容器的 testId；取消按钮缺省取 `${testId}-cancel`。 */
  testId?: string;
  cancelTestId?: string;
  confirmTestId?: string;
}

export function ConfirmDialog({
  open,
  title,
  children,
  cancelLabel,
  confirmLabel,
  onConfirm,
  onCancel,
  onOpenChange,
  variant = 'destructive',
  media,
  cancelDisabled,
  confirmDisabled,
  testId,
  cancelTestId,
  confirmTestId,
}: ConfirmDialogProps) {
  const cancelId = cancelTestId ?? (testId ? `${testId}-cancel` : undefined);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next: boolean) => {
        if (onOpenChange) onOpenChange(next);
        else if (!next) onCancel?.();
      }}
    >
      <AlertDialogContent data-testid={testId}>
        <AlertDialogHeader>
          {media ? (
            <AlertDialogMedia className="bg-destructive/10">{media}</AlertDialogMedia>
          ) : null}
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{children}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={cancelDisabled} onClick={onCancel} data-testid={cancelId}>
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            variant={variant}
            disabled={confirmDisabled}
            onClick={onConfirm}
            data-testid={confirmTestId}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
