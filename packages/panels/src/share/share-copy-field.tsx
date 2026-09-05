// 只读文本 + 复制按钮：链接与密码共用。复制走 `writeTextToClipboard`（Clipboard API 失败
// 时回退 execCommand），成败都给 toast，不静默。

import { writeTextToClipboard } from '@tmex/shared';
import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { toast } from '@tmex/ui/toast';
import { Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export interface ShareCopyFieldProps {
  label: string;
  value: string;
  /** 展示值与复制值不同（如密码遮罩）时传；不传即展示 `value`。 */
  display?: string;
  copyLabel: string;
  testId: string;
  disabled?: boolean;
}

export function ShareCopyField({
  label,
  value,
  display,
  copyLabel,
  testId,
  disabled,
}: ShareCopyFieldProps) {
  const { t } = useTranslation();

  const copy = (): void => {
    void writeTextToClipboard(value).then(
      () => toast.success(t('share.dialog.copied')),
      () => toast.error(t('share.dialog.copyFailed'))
    );
  };

  return (
    <div className="space-y-2">
      <span className="block text-sm font-medium">{label}</span>
      <div className="flex items-center gap-2">
        <Input
          readOnly
          value={display ?? value}
          data-testid={testId}
          className="font-mono"
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || !value}
          onClick={copy}
          data-testid={`${testId}-copy`}
          aria-label={copyLabel}
        >
          <Copy className="h-4 w-4" />
          {copyLabel}
        </Button>
      </div>
    </div>
  );
}
