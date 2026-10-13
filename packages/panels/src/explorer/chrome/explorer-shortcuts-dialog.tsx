// 键盘快捷键一览：静态的方向键行 + 从 EXPLORER_SHORTCUTS 派生的命令行，按用途分组留白。

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@vibeterm/ui/dialog';
import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import {
  EXPLORER_SHORTCUTS,
  type ExplorerCommand,
  formatChord,
  isApplePlatform,
} from '../model/shortcuts';

export interface ShortcutRow {
  id: string;
  labelKey: string;
  /** 外层是等价的几种按法（之间画细分隔线），内层是一种按法里依次排开的键帽 */
  alternatives: string[][];
}

const ARROWS = ['↑', '↓', '←', '→'];
const PLUS = '+';

// 导航 / 选择 / 编辑 / 标签页；表里没列到的命令归到最后一组
const COMMAND_GROUPS: ReadonlyArray<ReadonlyArray<ExplorerCommand>> = [
  ['open', 'openInNewTab', 'up', 'back', 'forward', 'refresh', 'focusFilter'],
  ['selectAll', 'clearSelection'],
  ['rename', 'delete', 'copy', 'cut', 'paste', 'newFolder', 'download'],
  ['newTab', 'closeTab', 'split', 'showShortcuts'],
];

function staticRows(apple: boolean): ShortcutRow[] {
  const shift = apple ? '⇧' : 'Shift';
  return [
    { id: 'move', labelKey: 'explorer.shortcuts.move', alternatives: [ARROWS] },
    {
      id: 'extend',
      labelKey: 'explorer.shortcuts.extend',
      alternatives: [[shift, PLUS, ...ARROWS]],
    },
    { id: 'typeAhead', labelKey: 'explorer.shortcuts.typeAhead', alternatives: [['A–Z']] },
  ];
}

function commandRow(command: ExplorerCommand, apple: boolean): ShortcutRow | null {
  const shortcut = EXPLORER_SHORTCUTS.find((item) => item.command === command);
  if (!shortcut || shortcut.chords.length === 0) return null;
  return {
    id: command,
    labelKey: shortcut.labelKey,
    alternatives: shortcut.chords.map((chord) => [formatChord(chord, apple)]),
  };
}

/** 分组后的行；没有绑定按键的命令不出现，空组被丢弃。 */
export function shortcutGroups(apple: boolean): ShortcutRow[][] {
  const grouped = new Set(COMMAND_GROUPS.flat());
  const ungrouped = EXPLORER_SHORTCUTS.map((item) => item.command).filter(
    (command) => !grouped.has(command)
  );
  const lastGroup = COMMAND_GROUPS.length - 1;
  const groups = COMMAND_GROUPS.map((commands, index) =>
    [...commands, ...(index === lastGroup ? ungrouped : [])]
      .map((command) => commandRow(command, apple))
      .filter((row): row is ShortcutRow => row !== null)
  );
  groups[0] = [...staticRows(apple), ...(groups[0] ?? [])];
  return groups.filter((rows) => rows.length > 0);
}

const KBD_CLASS =
  'inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1.5 font-sans text-[11px] leading-none text-muted-foreground';

function ShortcutKeys({ alternatives }: { alternatives: string[][] }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {alternatives.map((caps, index) => (
        <Fragment key={caps.join(' ')}>
          {index > 0 && <span aria-hidden className="h-3 w-px bg-border" />}
          <span className="flex items-center gap-1">
            {caps.map((cap) =>
              cap === PLUS ? (
                <span key={cap} aria-hidden className="text-[11px] text-muted-foreground/60">
                  {cap}
                </span>
              ) : (
                <kbd key={cap} className={KBD_CLASS}>
                  {cap}
                </kbd>
              )
            )}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

export function ExplorerShortcutsDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const { t } = useTranslation();
  const groups = shortcutGroups(isApplePlatform());
  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="explorer-shortcuts-dialog">
        <DialogHeader>
          <DialogTitle>{t('explorer.shortcuts.title')}</DialogTitle>
        </DialogHeader>
        <div className="-mx-1 max-h-[min(70vh,32rem)] space-y-3 overflow-y-auto px-1">
          {groups.map((rows) => (
            <dl key={rows[0]?.id} className="space-y-0.5">
              {rows.map((row) => (
                <div
                  key={row.id}
                  data-testid={`explorer-shortcut-${row.id}`}
                  className="flex min-h-7 items-center justify-between gap-4"
                >
                  <dt className="min-w-0 truncate text-[13px] text-foreground">
                    {t(row.labelKey)}
                  </dt>
                  <dd className="m-0">
                    <ShortcutKeys alternatives={row.alternatives} />
                  </dd>
                </div>
              ))}
            </dl>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
