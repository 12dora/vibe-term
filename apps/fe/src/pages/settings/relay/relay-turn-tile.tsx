// 中继内置 TURN 的磁贴：与相邻的指标格同一版式，右侧摆地址 / 探测 / 放行提示。
//
// 直连打不通时浏览器与节点都会退到 TURN，因此这一格的重点是「有没有在听」与「端口放行了没有」，
// 分配数用来确认它真的在干活；知道上限时写成 `12 / 49`。

import { Skeleton } from '@vibeterm/ui/skeleton';
import { StatTile } from '@vibeterm/ui/stat-tile';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type RelayTurnMembersProbe,
  type RelayTurnView,
  membersProbeTone,
  relayTurnStatusOf,
  relayTurnView,
} from './relay-turn-model';

export interface RelayTurnTileProps {
  /** 契约 §D 的那一段；旧中继不下发时整块不出现。 */
  turn: unknown;
  /** 首次加载：与相邻磁贴同样先摆骨架，别让卡片高度在数据到位时跳一下。 */
  loading?: boolean;
  /** 刷新失败但保留了上一份。 */
  stale?: boolean;
}

export function RelayTurnTile({ turn, loading = false, stale = false }: RelayTurnTileProps) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <TurnSection>
        <Skeleton className="h-[4.5rem] w-full rounded-xl" data-testid="relay-turn-skeleton" />
      </TurnSection>
    );
  }
  const status = relayTurnStatusOf(turn);
  if (!status) return null;
  const view = relayTurnView(status);
  const allocations = view.allocations;
  const value =
    allocations === null
      ? t(view.stateKey)
      : view.maxAlloc != null
        ? `${allocations} / ${view.maxAlloc}`
        : allocations;
  return (
    <TurnSection>
      <div
        className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start"
        data-testid="relay-turn"
      >
        <div className="w-full min-w-0 sm:max-w-xs">
          <StatTile
            label={t('relay.admin.turn.title')}
            value={value}
            unit={allocations === null ? undefined : t('relay.admin.turn.unitAllocations')}
            sub={
              allocations === null
                ? t(view.modeKey)
                : t('relay.admin.turn.sub', { mode: t(view.modeKey), state: t(view.stateKey) })
            }
            tone={view.tone}
            stale={stale}
            data-testid="relay-metric-turn"
          />
        </div>
        <RelayTurnDetails view={view} />
      </div>
    </TurnSection>
  );
}

function TurnSection({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {t('relay.admin.turn.section')}
      </h3>
      {children}
    </section>
  );
}

/** 磁贴右侧（窄屏在下方）的明细行。单独导出，供静态渲染的单测直接断言。 */
export function RelayTurnDetails({ view }: { view: RelayTurnView }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-[11px] text-muted-foreground">
      <span>{t('relay.admin.turn.hint')}</span>
      {view.endpoint && (
        <span className="truncate font-mono" data-testid="relay-turn-endpoint">
          {view.endpoint}
        </span>
      )}
      {view.externalIp && (
        <span data-testid="relay-turn-external-ip">
          {t('relay.admin.turn.externalIp', { ip: view.externalIp })}
        </span>
      )}
      {view.membersProbe && (
        <span
          className={membersProbeClass(view.membersProbe)}
          data-testid="relay-turn-members-probe"
        >
          {t('relay.admin.turn.membersProbe', {
            ok: view.membersProbe.ok,
            total: view.membersProbe.total,
          })}
        </span>
      )}
      {view.firewall && (
        <span data-testid="relay-turn-firewall">
          {t('relay.admin.turn.firewall', { port: view.firewall.port, range: view.firewall.range })}
        </span>
      )}
      {view.error && (
        <span className="break-all text-destructive" data-testid="relay-turn-error">
          {t('relay.admin.turn.failed', { message: view.error })}
        </span>
      )}
    </div>
  );
}

function membersProbeClass(probe: RelayTurnMembersProbe): string {
  const tone = membersProbeTone(probe);
  if (tone === 'destructive') return 'text-destructive';
  if (tone === 'warning') return 'text-amber-600 dark:text-amber-400';
  return '';
}
