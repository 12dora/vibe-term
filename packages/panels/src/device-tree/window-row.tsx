import { useSidebar } from '@tmex/ui/sidebar';
import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSortableRow } from './device-tree-dnd';
import { pickActivePane } from './device-tree-navigation';
import type { WindowRowProps } from './device-tree-row-props';
import { DeviceTreeRowShell } from './device-tree-row-shell';
import { WindowRowFooter } from './window-pane-list';
import { WindowRowHeader, WindowRowMenu } from './window-row-header';

export type { WindowRowProps };

export const WindowRow = memo(function WindowRow(props: WindowRowProps) {
  const { deviceId, tmuxWindow, isDeviceSelected, selectedWindowId, selectedPaneId } = props;
  const { t } = useTranslation();
  const { isMobile } = useSidebar();
  const sortable = useSortableRow(tmuxWindow.id);

  const { panes, id: windowId } = tmuxWindow;
  const hasMultiplePanes = panes.length > 1;
  const paneIds = useMemo(() => panes.map((pane) => pane.id), [panes]);
  const isPaneSelected =
    isDeviceSelected &&
    windowId === selectedWindowId &&
    panes.some((pane) => pane.id === selectedPaneId);

  const { onWindowClick } = props;
  const handleHeaderClick = useCallback(
    () => onWindowClick(deviceId, windowId, panes),
    [onWindowClick, deviceId, windowId, panes]
  );

  return (
    <DeviceTreeRowShell
      variant="window"
      sortable={sortable}
      isMobile={isMobile}
      dragHandleLabel={t('window.dragHandle')}
      rowGroupClassName="group"
      outerClassName="space-y-1"
      actions={
        !hasMultiplePanes && (
          <WindowRowMenu {...props} isPaneSelected={isPaneSelected} isMobile={isMobile} />
        )
      }
      footer={
        <WindowRowFooter
          {...props}
          paneIds={paneIds}
          isWindowSelected={isPaneSelected}
          isMobile={isMobile}
        />
      }
    >
      <WindowRowHeader
        tmuxWindow={tmuxWindow}
        paneIds={paneIds}
        activePane={pickActivePane(panes)}
        hasMultiplePanes={hasMultiplePanes}
        isPaneSelected={isPaneSelected}
        isMobile={isMobile}
        onClick={handleHeaderClick}
      />
    </DeviceTreeRowShell>
  );
});
