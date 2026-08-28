import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSortableRow } from './device-tree-dnd';
import type { PaneRowProps } from './device-tree-row-props';
import { DeviceTreeRowShell } from './device-tree-row-shell';
import { PaneRowActions, PaneRowContent } from './pane-row-content';

export type { PaneRowProps };

export const PaneRow = memo(function PaneRow(props: PaneRowProps) {
  const { deviceId, windowId, pane, isActive, isMobile, onPaneClick, agent, nav } = props;
  const { t } = useTranslation();
  const sortable = useSortableRow(pane.id);

  const handleClick = useCallback(
    () => onPaneClick(deviceId, windowId, pane.id),
    [onPaneClick, deviceId, windowId, pane.id]
  );

  return (
    <DeviceTreeRowShell
      variant="pane"
      sortable={sortable}
      isMobile={isMobile}
      dragHandleLabel={t('window.dragHandlePane')}
      rowGroupClassName="group/pane"
      actions={<PaneRowActions {...props} />}
      footer={agent && <agent.PaneSessions nav={nav} deviceId={deviceId} paneId={pane.id} />}
    >
      <PaneRowContent pane={pane} isActive={isActive} isMobile={isMobile} onClick={handleClick} />
    </DeviceTreeRowShell>
  );
});
