// 文件传输 / 端口映射弹窗里的节点下拉。离线或未登录的节点仍然列出但禁用，并在行尾标出原因，
// 免得「节点不见了」看起来像列表没加载完。

import { useTranslation } from 'react-i18next';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tmex/ui/select';
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
        disabled={disabled || options.length === 0}
      >
        <SelectValue>
          {selected ? (
            <span className="truncate">{selected.name}</span>
          ) : (
            <span className="text-muted-foreground">{t('devices.transfer.nodePlaceholder')}</span>
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
