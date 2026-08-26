import { useTranslation } from 'react-i18next';

import { cn } from '@tmex/ui';
import { Button } from '@tmex/ui/button';
import { ListTreeIcon, PlusIcon, TerminalIcon } from 'lucide-react';

import type { BindingInfo } from './use-agent-tab-model';

/** 顶栏：当前 pane 绑定 chip + 会话切换 / 新建按钮 */
export function AgentBindingStatus({
  binding,
  hasActiveSession,
  showNewSession,
  newSessionDisabled,
  onBindingClick,
  onNewSession,
  onSwitchSession,
}: {
  binding: BindingInfo | null;
  hasActiveSession: boolean;
  showNewSession: boolean;
  newSessionDisabled: boolean;
  onBindingClick: () => void;
  onNewSession: () => void;
  onSwitchSession: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex shrink-0 items-center gap-2 px-3 py-2">
      {binding ? (
        <button
          type="button"
          data-testid="agent-binding-chip"
          data-binding-state={binding.state}
          className={cn(
            'border-border flex min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
            hasActiveSession && binding.state === 'valid'
              ? 'hover:bg-muted cursor-pointer'
              : 'text-muted-foreground',
            binding.state === 'invalid' && 'opacity-60'
          )}
          onClick={onBindingClick}
          disabled={!hasActiveSession || binding.state === 'invalid'}
        >
          <TerminalIcon className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{binding.label}</span>
          {binding.state === 'invalid' && (
            <span className="shrink-0">· {t('agent.binding.invalid')}</span>
          )}
        </button>
      ) : (
        <div className="min-w-0 flex-1" />
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button
          data-testid="agent-session-switch"
          size="icon-sm"
          variant="ghost"
          onClick={onSwitchSession}
          aria-label={t('agent.session.switch')}
          title={t('agent.session.switch')}
        >
          <ListTreeIcon />
        </Button>
        {showNewSession && (
          <Button
            data-testid="agent-session-new"
            size="icon-sm"
            variant="ghost"
            disabled={newSessionDisabled}
            onClick={onNewSession}
            aria-label={t('agent.session.new')}
            title={newSessionDisabled ? t('agent.session.selectPaneHint') : t('agent.session.new')}
          >
            <PlusIcon />
          </Button>
        )}
      </div>
    </div>
  );
}
