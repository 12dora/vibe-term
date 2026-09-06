// 传输面板的条目列表：文件 + 目录，复选框多选，shift 点选区间，双击 / Enter 进目录。
//
// 行不是单个 `<button>`——复选框本身是可交互元素，套在按钮里是非法结构；这里外层用 div 承载
// `data-picker-index`（键盘处理靠它定位），名字部分才是按钮。超过阈值的长列表给行加
// content-visibility，避免一次铺开上千个节点。

import { formatBytes } from '@vibeterm/api-client';
import type { FileEntryDto } from '@vibeterm/shared';
import { cn } from '@vibeterm/ui';
import { Checkbox } from '@vibeterm/ui/checkbox';
import { File as FileIcon, Folder, Link2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isDirectoryEntry } from './pane-state';

/** 超过这个条数就给行加 content-visibility（与目录选择器同一口径）。 */
export const ENTRY_SKIP_RENDER_THRESHOLD = 200;

const SKIPPED_ROW_STYLE = {
  contentVisibility: 'auto',
  containIntrinsicSize: 'auto 32px',
} as const;

export interface TransferEntryListProps {
  entries: FileEntryDto[];
  selection: ReadonlySet<string>;
  highlight: number;
  onToggle: (index: number, path: string) => void;
  onRange: (index: number) => void;
  onEnter: (path: string) => void;
  /** 行获得焦点时把高亮同步过去，Tab 走位与方向键走位保持同一份状态。 */
  onFocusRow?: (index: number) => void;
  rowRefs?: { current: Array<HTMLButtonElement | null> };
}

export function TransferEntryList({
  entries,
  selection,
  highlight,
  onToggle,
  onRange,
  onEnter,
  onFocusRow,
  rowRefs,
}: TransferEntryListProps) {
  const { t } = useTranslation();
  const skipRender = entries.length > ENTRY_SKIP_RENDER_THRESHOLD;

  if (entries.length === 0) {
    return (
      <div
        className="py-8 text-center text-sm text-muted-foreground"
        data-testid="transfer-entries-empty"
      >
        {t('devices.transfer.empty')}
      </div>
    );
  }

  return (
    <div className="space-y-0.5 p-1" data-testid="transfer-entries">
      {entries.map((entry, index) => {
        const dir = isDirectoryEntry(entry);
        const checked = selection.has(entry.path);
        return (
          <div
            key={entry.path}
            data-picker-index={index}
            data-testid={`transfer-entry-${entry.name}`}
            style={skipRender ? SKIPPED_ROW_STYLE : undefined}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1',
              index === highlight ? 'bg-muted' : 'hover:bg-muted/60'
            )}
          >
            <Checkbox
              checked={checked}
              aria-label={entry.name}
              data-testid={`transfer-entry-check-${entry.name}`}
              onCheckedChange={() => onToggle(index, entry.path)}
            />
            <button
              type="button"
              data-picker-name=""
              ref={(node) => {
                if (rowRefs) rowRefs.current[index] = node;
              }}
              aria-current={index === highlight ? 'true' : undefined}
              className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm outline-none"
              onFocus={() => onFocusRow?.(index)}
              onClick={(event) => {
                if (event.shiftKey) onRange(index);
                else onToggle(index, entry.path);
              }}
              onDoubleClick={() => {
                if (dir) onEnter(entry.path);
              }}
            >
              {dir ? (
                <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate font-mono text-xs">{entry.name}</span>
              {entry.isSymlink && <Link2 className="h-3 w-3 shrink-0 text-muted-foreground" />}
              {entry.size !== null && !dir && (
                <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">
                  {formatBytes(entry.size)}
                </span>
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}
