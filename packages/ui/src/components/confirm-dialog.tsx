// 二次确认框：标题 + 正文 + 「取消 / 确认」两个按钮。
//
// 原先 fe（域名访问、直连插件、停 https、移除隧道、踢租户、纯中继、切换中继）与 panels
// （刷新页面、关闭窗格）各自拼一遍同一套 AlertDialog 骨架，差别只在文案、按钮样式与 testId。
// 确认按钮默认按破坏性操作渲染；testId 逐个显式传：历史上 `-ok` / `-confirm` / `-cancel`
// 几种后缀并存，e2e 与单测都在断言这些名字，不能顺手统一。
//
// 可选 `extra` / `input` 插在正文与页脚之间（卸载清单、吊销原因）；`actions` 整段替换页脚
// （退出 mesh 卡住时的「再查一次 / 刷新」），调用方不必再手写 AlertDialog*。

import { Loader2 } from 'lucide-react';
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
import { Input } from './input';

export interface ConfirmDialogInput {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  testId?: string;
  id?: string;
}

export interface ConfirmDialogActionSpec {
  label: ReactNode;
  onClick: () => void;
  testId?: string;
  variant?: 'default' | 'destructive' | 'outline';
  disabled?: boolean;
}

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
  /** 正文与页脚之间的任意内容（清单、警告、进度）。 */
  extra?: ReactNode;
  /** 可选输入槽（吊销原因等）；渲染在 `extra` 之后。 */
  input?: ConfirmDialogInput;
  contentClassName?: string;
  hideCancel?: boolean;
  confirmPending?: boolean;
  /** 传入则整段替换默认的取消/确认页脚。 */
  actions?: ConfirmDialogActionSpec[];
}

function onConfirmOpenChange(props: ConfirmDialogProps): (next: boolean) => void {
  return (next: boolean) => {
    if (props.onOpenChange) props.onOpenChange(next);
    else if (!next) props.onCancel?.();
  };
}

function cancelTestIdOf(props: ConfirmDialogProps): string | undefined {
  return props.cancelTestId ?? (props.testId ? `${props.testId}-cancel` : undefined);
}

function ConfirmDialogInputSlot({ input }: { input: ConfirmDialogInput }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium" htmlFor={input.id}>
        {input.label}
      </label>
      <Input
        id={input.id}
        value={input.value}
        className="h-9"
        onChange={(event) => input.onChange(event.target.value)}
        data-testid={input.testId}
      />
    </div>
  );
}

function ConfirmDialogAltFooter({ actions }: { actions: ConfirmDialogActionSpec[] }) {
  return (
    <AlertDialogFooter>
      {actions.map((action, index) => (
        <AlertDialogAction
          key={action.testId ?? String(index)}
          variant={action.variant}
          disabled={action.disabled}
          onClick={action.onClick}
          data-testid={action.testId}
        >
          {action.label}
        </AlertDialogAction>
      ))}
    </AlertDialogFooter>
  );
}

function ConfirmDialogDefaultFooter(props: ConfirmDialogProps) {
  return (
    <AlertDialogFooter>
      {props.hideCancel ? null : (
        <AlertDialogCancel
          disabled={props.cancelDisabled}
          onClick={props.onCancel}
          data-testid={cancelTestIdOf(props)}
        >
          {props.cancelLabel}
        </AlertDialogCancel>
      )}
      <AlertDialogAction
        variant={props.variant ?? 'destructive'}
        disabled={props.confirmDisabled}
        onClick={props.onConfirm}
        data-testid={props.confirmTestId}
      >
        {props.confirmPending ? (
          <Loader2 className="animate-spin motion-reduce:animate-none" />
        ) : null}
        {props.confirmLabel}
      </AlertDialogAction>
    </AlertDialogFooter>
  );
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  return (
    <AlertDialog open={props.open} onOpenChange={onConfirmOpenChange(props)}>
      <AlertDialogContent data-testid={props.testId} className={props.contentClassName}>
        <AlertDialogHeader>
          {props.media ? (
            <AlertDialogMedia className="bg-destructive/10">{props.media}</AlertDialogMedia>
          ) : null}
          <AlertDialogTitle>{props.title}</AlertDialogTitle>
          <AlertDialogDescription>{props.children}</AlertDialogDescription>
        </AlertDialogHeader>
        {props.extra}
        {props.input ? <ConfirmDialogInputSlot input={props.input} /> : null}
        {props.actions ? (
          <ConfirmDialogAltFooter actions={props.actions} />
        ) : (
          <ConfirmDialogDefaultFooter {...props} />
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
