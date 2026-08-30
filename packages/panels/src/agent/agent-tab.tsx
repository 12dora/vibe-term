import { useTranslation } from 'react-i18next';

import { AgentBindingStatus } from './agent-binding-status';
import { AgentComposer } from './agent-composer';
import { AgentStatusBanners } from './agent-status-banners';
import { ChatThread } from './chat-thread';
import { QueueChips } from './queue-chips';
import { useAgentTabModel } from './use-agent-tab-model';
import type { AgentTabHost } from './use-agent-tab-state';

export function AgentTab(host: AgentTabHost = {}) {
  const { t } = useTranslation();
  const model = useAgentTabModel(host);

  return (
    <div data-testid="agent-tab" className="flex h-full min-h-0 flex-col">
      <AgentBindingStatus
        binding={model.binding}
        hasActiveSession={Boolean(model.activeSession)}
        showNewSession={model.showNewSession}
        newSessionDisabled={model.newSessionDisabled}
        onBindingClick={model.onBindingClick}
        onNewSession={model.onNewSession}
        onSwitchSession={model.onSwitchSession}
      />

      <AgentStatusBanners
        isOrphan={model.isOrphan}
        showNodeOffline={model.showNodeOffline}
        showPaneMismatch={model.showPaneMismatch}
        bindingValid={model.binding?.state === 'valid'}
        canRebind={model.canRebind}
        errorText={model.errorText}
        retryText={model.retryText}
        sending={model.sending}
        onGoToBinding={model.onBindingClick}
        onRebind={model.onRebind}
        onRetry={model.onRetry}
      />

      {!model.draftEmpty && (
        <ChatThread
          key={model.activeSession?.id ?? (model.draft ? 'draft' : 'none')}
          blocks={model.activeSession ? model.blocks : []}
          running={model.running}
          emptyText={model.hasContext ? t('agent.panel.empty') : t('agent.session.selectPaneHint')}
          confirmationByToolCallId={model.confirmationByToolCallId}
          onDecide={model.onDecide}
          className="bg-chat-surface mx-3 mb-2 overflow-hidden rounded-xl"
        />
      )}

      {model.activeSession && !model.isOrphan && model.queuedItems.length > 0 && (
        <QueueChips
          queued={model.queuedItems}
          onEdit={model.onQueueEdit}
          onWithdraw={model.onQueueWithdraw}
          onSteer={model.onQueueSteer}
        />
      )}

      {model.hasContext && (
        <AgentComposer
          draftEmpty={model.draftEmpty}
          draftPrompt={model.draft?.prompt ?? null}
          disabled={model.inputDisabled}
          running={model.running}
          hasActiveSession={Boolean(model.activeSession)}
          isOrphan={model.isOrphan}
          writeMode={model.writeMode}
          allowControlChars={model.allowControlChars}
          modelProviderId={model.modelProviderId}
          modelId={model.modelId}
          onSend={model.onSend}
          onSteer={model.onSteer}
          onStop={model.onStop}
          onModelChange={model.onModelChange}
          onWriteModeChange={model.onWriteModeChange}
          onAllowControlCharsChange={model.onAllowControlCharsChange}
        />
      )}
    </div>
  );
}
