// 行内名称编辑框：重命名与新建文件夹共用。Enter / 失焦提交，Esc 取消；
// 自己吞掉键盘与指针事件，免得冒泡到视图容器触发选择、打开或拖拽。

import { cn } from '@vibeterm/ui';
import type { KeyboardEvent, SyntheticEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fileNameErrorKey, splitStem, validateFileName } from '../../files/ops/file-name';

export interface InlineNameEditorProps {
  initialName: string;
  /** 只选中主名（最后一个点之前）——重命名文件时用 */
  selectStem?: boolean;
  /** 名称没改也照样提交（新建文件夹直接回车用默认名）；默认没改即取消 */
  commitUnchanged?: boolean;
  className?: string;
  onCommit(name: string): void;
  onCancel(): void;
}

const EDITOR_CLASS =
  'h-6 min-w-0 rounded-sm border border-input bg-background px-1.5 text-foreground outline-none ring-2 ring-primary/40 transition-[border-color,box-shadow] duration-(--vibeterm-motion-fast) ease-out motion-reduce:transition-none';

function stopPropagation(event: SyntheticEvent): void {
  event.stopPropagation();
}

/** 键盘结束编辑后把焦点交还视图容器，方向键等才能接着用。 */
function restoreViewFocus(input: HTMLInputElement | null): void {
  input?.closest<HTMLElement>('[role="listbox"]')?.focus({ preventScroll: true });
}

export function InlineNameEditor({
  initialName,
  selectStem = false,
  commitUnchanged = false,
  className,
  onCommit,
  onCancel,
}: InlineNameEditorProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter / Esc 之后元素卸载还会触发一次 blur，只认第一次
  const settled = useRef(false);
  const error = validateFileName(value);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在挂载时聚焦并选中一次
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const end = selectStem ? splitStem(initialName).stem.length : initialName.length;
    input.setSelectionRange(0, end);
  }, []);

  const settle = (commit: boolean): void => {
    if (settled.current) return;
    settled.current = true;
    if (commit && (commitUnchanged || value !== initialName)) onCommit(value);
    else onCancel();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    event.stopPropagation();
    // 输入法选词的回车不算提交
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      restoreViewFocus(inputRef.current);
      settle(false);
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (error) return;
    restoreViewFocus(inputRef.current);
    settle(true);
  };

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      data-testid="explorer-name-editor"
      aria-label={t('files.ops.nameLabel')}
      aria-invalid={error ? true : undefined}
      title={error ? t(fileNameErrorKey(error)) : undefined}
      spellCheck={false}
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      draggable={false}
      className={cn(EDITOR_CLASS, error && 'border-destructive ring-destructive/50', className)}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => settle(error === null)}
      onClick={stopPropagation}
      onDoubleClick={stopPropagation}
      onContextMenu={stopPropagation}
      onPointerDown={stopPropagation}
      onMouseDown={stopPropagation}
      onDragStart={stopPropagation}
    />
  );
}
