// 传输弹窗的单侧面板：节点 → 根目录 → 目录浏览 + 多选，底部一个发送按钮。

import { Button } from '@tmex/ui/button';
import { ScrollArea } from '@tmex/ui/scroll-area';
import { Skeleton } from '@tmex/ui/skeleton';
import type { Dispatch } from 'react';
import { useTranslation } from 'react-i18next';

import type { DialogNodeOption } from '../dialog-nodes';
import { NodeSelect } from '../node-select';
import { TransferEntryList } from './entry-list';
import type { TransferPaneAction, TransferPaneState } from './pane-state';
import { PaneBreadcrumbs, PaneHiddenSwitch, PanePathBar, PaneRootSelect } from './pane-toolbar';
import { type TransferPaneModel, useTransferPane } from './use-transfer-pane';

function PaneList({
  model,
  state,
  dispatch,
  testId,
}: {
  model: TransferPaneModel;
  state: TransferPaneState;
  dispatch: Dispatch<TransferPaneAction>;
  testId: string;
}) {
  const { t } = useTranslation();
  if (model.listError) {
    return (
      <div className="py-8 text-center text-sm text-destructive" data-testid={`${testId}-error`}>
        {t('devices.transfer.loadFailed')}
      </div>
    );
  }
  if (model.listPending) {
    return (
      <div className="space-y-2 p-2">
        {[0, 1, 2, 3, 4].map((row) => (
          <Skeleton key={row} className="h-6 w-full" />
        ))}
      </div>
    );
  }
  return (
    <TransferEntryList
      entries={model.entries}
      selection={state.selection}
      highlight={state.highlight}
      rowRefs={model.rowRefs}
      onToggle={(index, path) => dispatch({ type: 'toggle', index, path })}
      onRange={(index) => dispatch({ type: 'range', index, paths: model.paths })}
      onEnter={(path) => dispatch({ type: 'navigate', path })}
    />
  );
}

export interface TransferPaneProps {
  state: TransferPaneState;
  dispatch: Dispatch<TransferPaneAction>;
  nodeOptions: DialogNodeOption[];
  side: 'left' | 'right';
  sendLabel: string;
  /** 不为 null 时按钮禁用，值即提示文案。 */
  sendBlockedReason: string | null;
  sending: boolean;
  onSend: () => void;
}

export function TransferPane(props: TransferPaneProps) {
  const { t } = useTranslation();
  const { state, dispatch, nodeOptions, side } = props;
  const testId = `transfer-pane-${side}`;
  const model = useTransferPane(state, dispatch);

  return (
    <section
      className="flex min-h-0 min-w-0 flex-col gap-2 rounded-lg border border-border p-2"
      data-testid={testId}
      onKeyDown={model.onKeyDown}
    >
      <div className="grid grid-cols-2 gap-2">
        <NodeSelect
          value={state.nodeId}
          options={nodeOptions}
          onChange={(nodeId) => dispatch({ type: 'selectNode', nodeId })}
          testId={`${testId}-node`}
          ariaLabel={t('devices.transfer.node')}
        />
        <PaneRootSelect
          roots={model.roots}
          value={state.rootId}
          onChange={(rootId) => dispatch({ type: 'selectRoot', rootId })}
          testId={`${testId}-root`}
        />
      </div>

      <PaneBreadcrumbs
        path={model.currentPath}
        onNavigate={(path) => dispatch({ type: 'navigate', path })}
      />

      <PanePathBar
        draft={state.draft}
        parent={model.parent}
        testId={testId}
        onDraft={(value) => dispatch({ type: 'draft', value })}
        onSubmit={() => dispatch({ type: 'submitDraft' })}
        onUp={() => {
          if (model.parent) dispatch({ type: 'navigate', path: model.parent });
        }}
      />

      <ScrollArea className="h-56 rounded-lg border border-border">
        <div>
          <PaneList model={model} state={state} dispatch={dispatch} testId={testId} />
        </div>
      </ScrollArea>

      <div className="flex items-center justify-between gap-2">
        <PaneHiddenSwitch
          hidden={state.hidden}
          testId={`${testId}-hidden`}
          onChange={(hidden) => dispatch({ type: 'toggleHidden', hidden })}
        />
        <span className="text-xs text-muted-foreground">
          {t('devices.transfer.selected', { count: state.selection.size })}
        </span>
      </div>

      <Button
        variant="secondary"
        size="sm"
        className="w-full"
        data-testid={`${testId}-send`}
        title={props.sendBlockedReason ?? undefined}
        disabled={props.sendBlockedReason !== null || props.sending}
        onClick={props.onSend}
      >
        {props.sending ? t('devices.transfer.sending') : props.sendLabel}
      </Button>
    </section>
  );
}
