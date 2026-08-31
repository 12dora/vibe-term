// 指引里的命令 / 地址块：等宽展示 + 一键复制。复制状态与播报沿用节点设置那套。

import { CopyLabel, useCopyToClipboard } from '@/pages/settings/nodes/copy-feedback';
import { Button } from '@tmex/ui/button';
import { Check, Copy } from 'lucide-react';

export function CommandBlock({
  value,
  testId,
  label,
}: {
  value: string;
  testId: string;
  label?: string;
}) {
  const { copied, copy } = useCopyToClipboard(value);
  return (
    <div className="flex flex-col gap-1">
      {label ? <span className="text-[11px] text-muted-foreground">{label}</span> : null}
      <div className="flex items-start gap-1">
        <code
          className="min-w-0 flex-1 overflow-x-auto break-all rounded-lg bg-muted/50 p-2 font-mono text-[11px]"
          data-testid={`command-block-${testId}`}
        >
          {value}
        </code>
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={copy}
          data-testid={`command-block-${testId}-copy`}
        >
          {copied ? <Check className="tmex-scale-in" /> : <Copy className="tmex-scale-in" />}
          <CopyLabel copied={copied} />
        </Button>
      </div>
    </div>
  );
}
