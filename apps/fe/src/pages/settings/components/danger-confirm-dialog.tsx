// 破坏性操作的二次确认框。实现已上移到 `@tmex/ui/confirm-dialog`（panels 侧也用同一份），
// 这里只保留 fe 沿用多年的名字与导入路径。

export {
  ConfirmDialog as DangerConfirmDialog,
  type ConfirmDialogProps as DangerConfirmDialogProps,
} from '@tmex/ui/confirm-dialog';
