// 内存限额只读写入口网关自己的记录，远端节点走节点表的单行 / 批量对话框。
import { useRouteNodeId } from '@/node/node-runtime-boundary';
import { isSelfNode } from '@vibeterm/api-client';
import { TerminalSettingsTab as TerminalSettingsPanels } from '@vibeterm/panels/settings/terminal';
import type { ReactNode } from 'react';
import { MemoryLimitsSection } from './nodes/memory-limits-section';

export function memoryLimitsSlot(routeNodeId: string): ReactNode {
  return isSelfNode(routeNodeId) ? <MemoryLimitsSection /> : undefined;
}

export function TerminalSettingsTab() {
  return <TerminalSettingsPanels memoryLimits={memoryLimitsSlot(useRouteNodeId())} />;
}
