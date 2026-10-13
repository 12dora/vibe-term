// 「新建文件夹 / 重命名」共用的单字段对话框：就地校验名称，提交期间锁住确认按钮。

import { Button } from '@vibeterm/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibeterm/ui/dialog';
import { Input } from '@vibeterm/ui/input';
import { type FormEvent, type RefObject, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fileNameErrorKey, splitStem, validateFileName } from './file-name';

export interface FileNameDialogProps {
  open: boolean;
  title: string;
  confirmLabel: string;
  initialName: string;
  /** 目录里已有的名称，用于就地提示「已存在同名项目」。 */
  takenNames?: ReadonlySet<string>;
  /** 打开时只选中主名（最后一个点之前），用于文件重命名。 */
  selectStem?: boolean;
  /** 返回 true 才关闭；对话框在结果回来之前已被关掉或重新打开时，这个结果作废。 */
  onSubmit: (name: string) => Promise<boolean> | boolean;
  onClose: () => void;
}

/** 当前输入该显示的错误文案键；与原名相同不算重名（重命名时原名本来就在目录里）。 */
export function fileNameDialogErrorKey(
  name: string,
  initialName: string,
  takenNames?: ReadonlySet<string>
): string | null {
  const error = validateFileName(name);
  if (error) return fileNameErrorKey(error);
  if (name !== initialName && takenNames?.has(name)) return 'files.ops.nameTaken';
  return null;
}

interface FileNameForm {
  value: string;
  pending: boolean;
  errorKey: string | null;
  inputRef: RefObject<HTMLInputElement | null>;
  onInputChange: (value: string) => void;
  selectUntouched: () => void;
  ensureFocus: (open: boolean) => void;
  submit: (event: FormEvent) => Promise<void>;
}

/** 打开时该选中的范围终点：文件重命名只选主名，其余全选。 */
export function initialSelectionEnd(name: string, selectStem?: boolean): number {
  return selectStem ? splitStem(name).stem.length : name.length;
}

function useFileNameForm(props: FileNameDialogProps): FileNameForm {
  const { open, initialName, onSubmit, onClose } = props;
  const [value, setValue] = useState(initialName);
  const [pending, setPending] = useState(false);
  const [prevOpen, setPrevOpen] = useState(open);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // 用户动过输入之后就不再替他改选区
  const touched = useRef(false);
  // 每打开一次算一轮；提交结果回来时轮次对不上（已关掉 / 已重开）就作废
  const session = useRef(0);
  const openRef = useRef(open);
  openRef.current = open;

  // 每次打开都从 initialName 重新开始（渲染期对齐，避免先闪一帧上次的输入）
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setValue(initialName);
      setPending(false);
      touched.current = false;
      session.current += 1;
    }
  }

  const errorKey = fileNameDialogErrorKey(value, initialName, props.takenNames);

  const selectUntouched = () => {
    const input = inputRef.current;
    if (!input || touched.current) return;
    input.setSelectionRange(0, initialSelectionEnd(input.value, props.selectStem));
  };

  // 从右键菜单打开时，菜单收起会把焦点还给它的触发行，可能晚于对话框的初始聚焦；
  // 开场动画结束后再确认一次，焦点跑到对话框外才拿回来（聚焦即按上面的规则选中）。
  // 焦点已在对话框内（用户按 Tab 到了按钮上）就不动它。
  const ensureFocus = (nextOpen: boolean) => {
    const input = inputRef.current;
    if (!nextOpen || !input) return;
    const active = input.ownerDocument.activeElement;
    const dialog = input.closest('[role="dialog"]');
    if (active !== input && !dialog?.contains(active)) input.focus();
  };

  const onInputChange = (next: string) => {
    touched.current = true;
    setValue(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (errorKey || pending) return;
    const submitted = session.current;
    setPending(true);
    let done = false;
    try {
      done = await onSubmit(value);
    } finally {
      // 轮次变了说明对话框已经在为下一次打开服务，pending 已由那次打开清零
      if (session.current === submitted) setPending(false);
    }
    if (done && openRef.current && session.current === submitted) onClose();
  };

  return {
    value,
    pending,
    errorKey,
    inputRef,
    onInputChange,
    selectUntouched,
    ensureFocus,
    submit,
  };
}

export function FileNameDialog(props: FileNameDialogProps) {
  const { open, onClose } = props;
  const { t } = useTranslation();
  const inputId = useId();
  const errorId = useId();
  const form = useFileNameForm(props);
  const { value, pending, errorKey } = form;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      onOpenChangeComplete={form.ensureFocus}
    >
      <DialogContent data-testid="file-name-dialog" initialFocus={form.inputRef}>
        <form onSubmit={form.submit}>
          <DialogHeader>
            <DialogTitle>{props.title}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5 py-4">
            <label className="block text-xs font-medium" htmlFor={inputId}>
              {t('files.ops.nameLabel')}
            </label>
            <Input
              id={inputId}
              ref={form.inputRef}
              autoComplete="off"
              spellCheck={false}
              value={value}
              aria-invalid={errorKey ? true : undefined}
              aria-describedby={errorKey ? errorId : undefined}
              onChange={(event) => form.onInputChange(event.target.value)}
              onFocus={form.selectUntouched}
              data-testid="file-name-input"
            />
            {errorKey ? (
              <p id={errorId} className="text-destructive text-xs" data-testid="file-name-error">
                {t(errorKey)}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={errorKey !== null || pending}
              data-testid="file-name-confirm"
            >
              {props.confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
