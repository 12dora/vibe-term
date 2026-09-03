// 破坏性操作的二次确认框：标题 + 正文 + 「取消 / 危险确认」两个按钮。
//
// 域名访问、直连插件删除、停 https 监听、移除命名隧道四处原本各存一份结构相同的拷贝，
// 差别只在文案与 testId。确认按钮的 testId 单独传：历史上 `-ok` 与 `-confirm` 两种后缀并存，
// e2e 与单测都在断言这些名字，不能顺手统一。

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@tmex/ui/alert-dialog';
import type { ReactNode } from 'react';

export interface DangerConfirmDialogProps {
  open: boolean;
  title: string;
  cancelLabel: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  /** 内容容器的 testId；取消按钮取 `${testId}-cancel`。 */
  testId: string;
  confirmTestId: string;
  children: ReactNode;
}

export function DangerConfirmDialog({
  open,
  title,
  cancelLabel,
  confirmLabel,
  onCancel,
  onConfirm,
  testId,
  confirmTestId,
  children,
}: DangerConfirmDialogProps) {
  if (!open) return null;
  return (
    <AlertDialog
      open
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent data-testid={testId}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{children}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel} data-testid={`${testId}-cancel`}>
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm} data-testid={confirmTestId}>
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
