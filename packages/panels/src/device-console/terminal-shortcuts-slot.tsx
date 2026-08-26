// 终端快捷键栏：从服务器配置渲染（send 类发送控制序列，action 类触发特殊动作）。
// 单屏与分屏两种终端布局共用同一个浮层槽位。

import { useQuery } from '@tanstack/react-query';
import { fetchTerminalShortcuts, terminalShortcutsQueryKey } from '@tmex/api-client';
import type { TerminalShortcutItem } from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { memo, useMemo } from 'react';
import { ShortcutButtonRow } from '../settings/ShortcutButtonRow';

export const ShortcutsBar = memo(function ShortcutsBar({
  onActivate,
  disabled,
}: {
  onActivate: (item: TerminalShortcutItem) => void;
  disabled: boolean;
}) {
  const runtime = useRuntime();
  const { data } = useQuery({
    queryKey: terminalShortcutsQueryKey,
    queryFn: () => fetchTerminalShortcuts(runtime.apiClient),
    staleTime: 60_000,
  });
  const agentUi = runtime.features.agentUi;
  // agent UI 关闭时在渲染前过滤 newAgentSession：服务端配置仍可能下发该按钮，
  // 渲染出来会成为点了没反应的死按钮
  const items = useMemo(() => {
    const all = data?.items ?? [];
    if (agentUi) {
      return all;
    }
    return all.filter((item) => !(item.type === 'action' && item.action === 'newAgentSession'));
  }, [agentUi, data?.items]);
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="terminal-shortcuts-strip" data-testid="terminal-shortcuts-strip">
      <ShortcutButtonRow
        items={items}
        useIcons={data?.useIcons ?? false}
        onActivate={onActivate}
        disabled={disabled}
        preventFocusSteal
        rowTestId="terminal-shortcuts-row"
        idPrefix="terminal-shortcut"
      />
    </div>
  );
});

export interface TerminalShortcutsSlotProps {
  /** direct 模式才渲染：editor 模式的快捷键栏由编辑器自己承载 */
  visible: boolean;
  background: string;
  onActivate: (item: TerminalShortcutItem) => void;
  disabled: boolean;
}

/**
 * direct 模式：快捷键栏拼在终端可视区域下方，与终端共用 seoul256 配色。
 * follow 键盘模式弹起时，外层 .kb-floating-shortcuts 按 --tmex-kb-shortcut-lift
 * 把这排快捷键 translateY 浮到键盘正上方（不脱流，故不触发终端 resize）。
 */
export function TerminalShortcutsSlot({
  visible,
  background,
  onActivate,
  disabled,
}: TerminalShortcutsSlotProps) {
  if (!visible) {
    return null;
  }
  return (
    <div className="kb-floating-shortcuts" style={{ backgroundColor: background }}>
      <ShortcutsBar onActivate={onActivate} disabled={disabled} />
    </div>
  );
}
