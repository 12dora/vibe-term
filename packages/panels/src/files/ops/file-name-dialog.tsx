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
import { type FocusEvent, type FormEvent, useId, useRef, useState } from 'react';
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
  /** 返回 true 才关闭。 */
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
  setValue: (value: string) => void;
  pending: boolean;
  errorKey: string | null;
  selectOnFirstFocus: (event: FocusEvent<HTMLInputElement>) => void;
  submit: (event: FormEvent) => Promise<void>;
}

function useFileNameForm(props: FileNameDialogProps): FileNameForm {
  const { open, initialName, onSubmit, onClose } = props;
  const [value, setValue] = useState(initialName);
  const [pending, setPending] = useState(false);
  const [prevOpen, setPrevOpen] = useState(open);
  const selectionDone = useRef(false);

  // 每次打开都从 initialName 重新开始（渲染期对齐，避免先闪一帧上次的输入）
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setValue(initialName);
      selectionDone.current = false;
    }
  }

  const errorKey = fileNameDialogErrorKey(value, initialName, props.takenNames);

  const selectOnFirstFocus = (event: FocusEvent<HTMLInputElement>) => {
    if (selectionDone.current) return;
    selectionDone.current = true;
    const input = event.currentTarget;
    const end = props.selectStem ? splitStem(input.value).stem.length : input.value.length;
    input.setSelectionRange(0, end);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (errorKey || pending) return;
    setPending(true);
    let done = false;
    try {
      done = await onSubmit(value);
    } finally {
      setPending(false);
    }
    if (done) onClose();
  };

  return { value, setValue, pending, errorKey, selectOnFirstFocus, submit };
}

export function FileNameDialog(props: FileNameDialogProps) {
  const { open, onClose } = props;
  const { t } = useTranslation();
  const inputId = useId();
  const errorId = useId();
  const { value, setValue, pending, errorKey, selectOnFirstFocus, submit } = useFileNameForm(props);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="file-name-dialog">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{props.title}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5 py-4">
            <label className="block text-xs font-medium" htmlFor={inputId}>
              {t('files.ops.nameLabel')}
            </label>
            <Input
              id={inputId}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={value}
              aria-invalid={errorKey ? true : undefined}
              aria-describedby={errorKey ? errorId : undefined}
              onChange={(event) => setValue(event.target.value)}
              onFocus={selectOnFirstFocus}
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
