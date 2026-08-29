// 文件夹名称的就地编辑：新建行与重命名共用。
// Enter 保存 / Esc 取消 / blur 保存（内容为空的 blur 视为取消，否则用户会被卡在错误态里出不来）。

import {
  DEVICE_FOLDER_NAME_MAX_LENGTH,
  type DeviceFolderNameError,
  validateDeviceFolderName,
} from '@tmex/shared';
import { Input } from '@tmex/ui/input';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

const FOCUS_SETTLE_MS = 250;

export interface FolderNameEditorProps {
  initialName?: string;
  testId: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
  className?: string;
}

export function FolderNameEditor({
  initialName = '',
  testId,
  onSubmit,
  onCancel,
  className,
}: FolderNameEditorProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initialName);
  const [error, setError] = useState<DeviceFolderNameError | null>(null);
  // Esc 会先触发 blur，靠这个标记让 blur 分支不再抢着保存
  const cancelledRef = useRef(false);
  // 从下拉菜单里进入编辑态时，菜单关闭会把焦点还给触发按钮，紧跟着的 blur 不是用户意图：
  // 挂载后的一小段窗口内把焦点抢回来，而不是提交/放弃。
  const inputRef = useRef<HTMLInputElement>(null);
  const mountedAtRef = useRef(0);
  useEffect(() => {
    mountedAtRef.current = Date.now();
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const commit = (next: string) => {
    const result = validateDeviceFolderName(next);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSubmit(result.name);
  };

  return (
    <div className={className}>
      <Input
        ref={inputRef}
        autoFocus
        data-testid={testId}
        value={value}
        aria-invalid={error !== null}
        maxLength={DEVICE_FOLDER_NAME_MAX_LENGTH * 2}
        placeholder={t('devices.folders.namePlaceholder')}
        className="h-7 text-sm"
        onChange={(event) => {
          setValue(event.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit(value);
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            cancelledRef.current = true;
            onCancel();
          }
        }}
        onBlur={(event) => {
          if (cancelledRef.current) return;
          if (Date.now() - mountedAtRef.current < FOCUS_SETTLE_MS) {
            const input = event.currentTarget;
            window.requestAnimationFrame(() => input.focus());
            return;
          }
          const result = validateDeviceFolderName(value);
          // 空内容的失焦当作放弃；写了名字但不合法的仍然提示错误，不静默丢掉输入
          if (!result.ok && result.error === 'empty') onCancel();
          else commit(value);
        }}
      />
      {error && (
        <p data-testid={`${testId}-error`} className="pt-1 text-xs text-destructive">
          {error === 'empty'
            ? t('devices.folders.nameRequired')
            : t('devices.folders.nameTooLong', { max: DEVICE_FOLDER_NAME_MAX_LENGTH })}
        </p>
      )}
    </div>
  );
}
