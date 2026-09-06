// 面板工具条：面包屑、上一级、可编辑路径、根目录下拉、隐藏文件开关。

import type { FileRootDto } from '@tmex/shared';
import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tmex/ui/select';
import { Switch } from '@tmex/ui/switch';
import { ArrowUp, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { transferBreadcrumbs } from './pane-state';

export function PaneBreadcrumbs({
  path,
  onNavigate,
}: {
  path: string;
  onNavigate: (path: string) => void;
}) {
  const crumbs = transferBreadcrumbs(path);
  if (crumbs.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-0.5 text-xs text-muted-foreground">
      {crumbs.map((crumb, index) => (
        <span key={crumb.path} className="flex items-center gap-0.5">
          {index > 0 && <ChevronRight className="h-3 w-3 shrink-0" />}
          <button
            type="button"
            className="max-w-32 truncate rounded px-1 py-0.5 font-mono hover:bg-muted hover:text-foreground"
            onClick={() => onNavigate(crumb.path)}
          >
            {crumb.label}
          </button>
        </span>
      ))}
    </div>
  );
}

export function PaneRootSelect({
  roots,
  value,
  onChange,
  testId,
}: {
  roots: FileRootDto[];
  value: string | null;
  onChange: (rootId: string) => void;
  testId: string;
}) {
  const { t } = useTranslation();
  const selected = roots.find((root) => root.id === value);
  return (
    <Select
      value={value ?? ''}
      onValueChange={(next: string | null) => {
        if (next) onChange(next);
      }}
    >
      <SelectTrigger
        data-testid={testId}
        aria-label={t('devices.transfer.root')}
        className="h-9 w-full"
        disabled={roots.length === 0}
      >
        <SelectValue>
          {selected ? (
            <span className="truncate">{selected.name}</span>
          ) : (
            <span className="text-muted-foreground">
              {t(
                roots.length === 0
                  ? 'devices.transfer.rootEmpty'
                  : 'devices.transfer.rootPlaceholder'
              )}
            </span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {roots.map((root) => (
          <SelectItem key={root.id} value={root.id}>
            <span className="min-w-0 truncate">{root.name}</span>
            <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
              {root.path}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export interface PanePathBarProps {
  draft: string;
  parent: string | null;
  onDraft: (value: string) => void;
  onSubmit: () => void;
  onUp: () => void;
  testId: string;
}

export function PanePathBar({ draft, parent, onDraft, onSubmit, onUp, testId }: PanePathBarProps) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="icon-sm"
        title={t('devices.transfer.up')}
        aria-label={t('devices.transfer.up')}
        data-testid={`${testId}-up`}
        disabled={parent === null}
        onClick={onUp}
      >
        <ArrowUp className="h-4 w-4" />
      </Button>
      <Input
        data-testid={`${testId}-path`}
        aria-label={t('devices.transfer.pathLabel')}
        className="h-8 font-mono text-xs"
        value={draft}
        onChange={(event) => onDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          onSubmit();
        }}
      />
    </div>
  );
}

export function PaneHiddenSwitch({
  hidden,
  onChange,
  testId,
}: {
  hidden: boolean;
  onChange: (hidden: boolean) => void;
  testId: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Switch
        checked={hidden}
        data-testid={testId}
        aria-label={t('devices.transfer.showHidden')}
        onCheckedChange={(checked: boolean) => onChange(Boolean(checked))}
      />
      <span>{t('devices.transfer.showHidden')}</span>
    </div>
  );
}
