// 侧边栏 agent 会话行：pane 分支下的紧凑行、孤立会话区的带元信息行，及共用的操作菜单。

import type { AgentSessionDto } from '@tmex/shared';
import { formatDateTime } from '@tmex/shared';
import { useSiteStore } from '@tmex/stores/react';
import { cn } from '@tmex/ui';
import { Button } from '@tmex/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tmex/ui/dropdown-menu';
import { useSidebar } from '@tmex/ui/sidebar';
import { Bot, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSidebarAgentCommands } from './use-sidebar-agent-sessions';

export function StatusDot({ status }: { status: AgentSessionDto['status'] }) {
  return (
    <span
      className={cn(
        'size-2 shrink-0 rounded-full',
        status === 'running'
          ? 'bg-emerald-500 motion-safe:animate-pulse'
          : status === 'error'
            ? 'bg-destructive'
            : status === 'waiting_confirmation'
              ? 'bg-amber-500'
              : 'bg-muted-foreground/40'
      )}
    />
  );
}

function SessionActionsMenu({
  session,
  enlargeOnTouch = false,
}: {
  session: AgentSessionDto;
  enlargeOnTouch?: boolean;
}) {
  const { t } = useTranslation();
  const { isMobile } = useSidebar();
  const { requestRenameSession, requestDeleteSession } = useSidebarAgentCommands();
  const enlarged = enlargeOnTouch && isMobile;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid={`agent-session-menu-${session.id}`}
            aria-label={t('agent.session.menu')}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'size-5 shrink-0 text-muted-foreground transition-opacity duration-(--tmex-motion-standard) ease-out motion-reduce:transition-none data-popup-open:opacity-100',
              isMobile
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-100 [@media(any-pointer:coarse)]:opacity-100',
              enlarged && 'size-9'
            )}
          />
        }
      >
        <MoreHorizontal className={cn('size-3.5', enlarged && 'size-5')} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        backdrop
        className="w-auto min-w-36 [@media(any-pointer:coarse)]:min-w-48"
      >
        <DropdownMenuItem
          data-testid="agent-session-rename"
          className={cn(
            '[@media(any-pointer:coarse)]:py-2.5 [@media(any-pointer:coarse)]:px-2',
            isMobile && 'py-3 px-2.5 text-base gap-2.5'
          )}
          onClick={() => requestRenameSession(session)}
        >
          <Pencil className={cn('h-4 w-4', isMobile && 'h-5 w-5')} />
          {t('agent.session.rename')}
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          data-testid="agent-session-delete"
          className={cn(
            '[@media(any-pointer:coarse)]:py-2.5 [@media(any-pointer:coarse)]:px-2',
            isMobile && 'py-3 px-2.5 text-base gap-2.5'
          )}
          onClick={() => requestDeleteSession(session)}
        >
          <Trash2 className={cn('h-4 w-4', isMobile && 'h-5 w-5')} />
          {t('agent.session.delete')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const PaneSessionRow = memo(function PaneSessionRow({
  session,
  isActive,
  paused = false,
  onSelect,
}: {
  session: AgentSessionDto;
  isActive: boolean;
  /** 所在 node 离线：灰显且不可点入（点进去只会得到一屏请求错误） */
  paused?: boolean;
  onSelect: (session: AgentSessionDto) => void;
}) {
  const { isMobile } = useSidebar();
  return (
    <div className="group relative">
      <button
        type="button"
        data-testid={`agent-session-item-${session.id}`}
        disabled={paused}
        data-paused={paused ? '' : undefined}
        onClick={() => onSelect(session)}
        className={cn(
          'w-full flex items-center gap-1.5 px-2 py-1 pr-7 rounded-md text-left transition-colors duration-(--tmex-motion-fast) ease-out motion-reduce:transition-none [@media(any-pointer:coarse)]:min-h-11 [@media(any-pointer:coarse)]:py-2 [@media(any-pointer:coarse)]:pr-12',
          isMobile && 'min-h-11 py-2 pr-12',
          paused
            ? 'text-muted-foreground/60'
            : isActive
              ? 'bg-primary/10 text-primary'
              : 'hover:bg-accent/30 text-muted-foreground'
        )}
      >
        <Bot className="size-3 shrink-0 opacity-70" />
        <span className="min-w-0 flex-1 truncate text-[11px]">{session.title}</span>
        <StatusDot status={session.status} />
      </button>
      <div className="absolute right-0.5 top-1/2 -translate-y-1/2">
        <SessionActionsMenu session={session} enlargeOnTouch />
      </div>
    </div>
  );
});

export const OrphanSessionRow = memo(function OrphanSessionRow({
  session,
  isActive,
  paused = false,
  onSelect,
}: {
  session: AgentSessionDto;
  isActive: boolean;
  /** 所在 node 离线：灰显且不可点入 */
  paused?: boolean;
  onSelect: (session: AgentSessionDto) => void;
}) {
  const language = useSiteStore((state) => state.settings?.language ?? 'en_US');
  const meta = [
    session.originPaneTitle,
    session.originProcessName,
    formatDateTime(session.createdAt, language),
  ].filter((value): value is string => Boolean(value));

  return (
    <div className="group relative">
      <button
        type="button"
        data-testid={`agent-orphan-session-${session.id}`}
        disabled={paused}
        data-paused={paused ? '' : undefined}
        onClick={() => onSelect(session)}
        className={cn(
          'w-full flex flex-col gap-0.5 px-2 py-1.5 pr-7 rounded-lg text-left transition-colors duration-(--tmex-motion-fast) ease-out motion-reduce:transition-none',
          paused
            ? 'text-muted-foreground/60'
            : isActive
              ? 'bg-primary/10 text-primary'
              : 'hover:bg-accent/30'
        )}
      >
        <span className="flex items-center gap-1.5">
          <Bot className="size-3 shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate text-[11px]">{session.title}</span>
          <StatusDot status={session.status} />
        </span>
        {meta.length > 0 && (
          <span className="truncate pl-[18px] text-[10px] text-muted-foreground">
            {meta.join(' · ')}
          </span>
        )}
      </button>
      <div className="absolute right-0.5 top-1.5">
        <SessionActionsMenu session={session} />
      </div>
    </div>
  );
});
