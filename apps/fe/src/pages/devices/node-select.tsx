// 文件传输 / 端口映射弹窗里的节点下拉。离线或未登录的节点仍然列出但禁用，并在行尾标出原因，
// 免得「节点不见了」看起来像列表没加载完。
//
// 成员列表还在同步时选项为空（`toDialogNodeOptions` 的 loading 分支）：下拉禁用并显示
// 「加载中」，不能把本机画成唯一成员。

import { useTranslation } from 'react-i18next';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@vibeterm/ui/select';
import { type DialogNodeOption, findDialogNode, nodeUnavailableReason } from './dialog-nodes';

function ReasonTag({ option }: { option: DialogNodeOption }) {
  const { t } = useTranslation();
  const reason = nodeUnavailableReason(option);
  if (!reason) return null;
  return (
    <span className="ml-auto shrink-0 text-[10px] leading-none text-muted-foreground">
      {t(reason === 'offline' ? 'devices.nodes.status.offline' : 'devices.nodes.status.signedOut')}
    </span>
  );
}

export interface NodeSelectProps {
  value: string | null;
  options: DialogNodeOption[];
  onChange: (nodeId: string) => void;
  testId: string;
  ariaLabel: string;
  disabled?: boolean;
}

export function NodeSelect({
  value,
  options,
  onChange,
  testId,
  ariaLabel,
  disabled,
}: NodeSelectProps) {
  const { t } = useTranslation();
  const selected = findDialogNode(options, value);
  // 空选项只有一种来源：成员列表还在同步（否则至少有本机自己，见 `toDialogNodeOptions`）。
  const loading = options.length === 0;

  return (
    <Select
      value={value ?? ''}
      onValueChange={(next: string | null) => {
        if (next) onChange(next);
      }}
    >
      <SelectTrigger
        data-testid={testId}
        aria-label={ariaLabel}
        className="h-9 w-full"
        disabled={disabled || loading}
      >
        <SelectValue>
          {selected ? (
            <span className="truncate">{selected.name}</span>
          ) : (
            <span className="text-muted-foreground">
              {t(loading ? 'common.loading' : 'devices.transfer.nodePlaceholder')}
            </span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id} disabled={!option.usable}>
            <span className="min-w-0 truncate">{option.name}</span>
            <ReasonTag option={option} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
