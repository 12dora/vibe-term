import type { TmuxPane } from '@tmex/shared';

export function paneDisplayName(pane: TmuxPane | undefined): string {
  return pane?.customName?.trim() || pane?.title?.trim() || 'Pane';
}

export function paneMetaText(pane: TmuxPane | undefined): string | null {
  const command = pane?.currentCommand?.trim();
  if (!command) return null;
  const path = pane?.currentPath?.trim();
  return path ? `${command}@${path}` : command;
}
