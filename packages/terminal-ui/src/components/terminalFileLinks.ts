import type { TmuxSession } from '@tmex/shared';
import type { TerminalFileLinkRoot } from '@tmex/stores';

/**
 * 终端里点开的绝对路径归属哪个授权根：命中前缀的根里取最长的一个。
 * 根 `/` 覆盖全部路径，其余根必须按 `<root>/` 边界匹配，避免 `/a/bc` 误落到 `/a/b`。
 */
export function resolveFileLinkRoot(
  roots: readonly TerminalFileLinkRoot[],
  path: string
): TerminalFileLinkRoot | null {
  return (
    roots
      .filter(
        (root) => path === root.path || path.startsWith(root.path === '/' ? '/' : `${root.path}/`)
      )
      .sort((left, right) => right.path.length - left.path.length)[0] ?? null
  );
}

/** pane 的 tmux cwd：文件链接把相对路径解析成绝对路径的基准 */
export function findPaneCurrentPath(
  session: TmuxSession | null | undefined,
  paneId: string
): string | undefined {
  if (!session) {
    return undefined;
  }
  for (const win of session.windows) {
    for (const pane of win.panes) {
      if (pane.id === paneId) {
        return pane.currentPath;
      }
    }
  }
  return undefined;
}
