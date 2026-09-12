// 中继内置 TURN 的磁贴：与相邻的指标格同一版式，多出一段地址/报错/放行提示的明细。
//
// 直连打不通时浏览器与节点都会退到 TURN，因此这一格的重点是「有没有在听」与「端口放行了没有」，
// 而不是 allocation 这个数字本身——数字只用来确认它真的在干活。

import { Skeleton } from '@vibeterm/ui/skeleton';
import { StatTile } from '@vibeterm/ui/stat-tile';
import { useTranslation } from 'react-i18next';
import { type RelayTurnView, relayTurnStatusOf, relayTurnView } from './relay-turn-model';

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
    return <Skeleton className="h-[4.5rem] w-full rounded-xl" data-testid="relay-turn-skeleton" />;
  }
  const status = relayTurnStatusOf(turn);
  if (!status) return null;
  const view = relayTurnView(status);
  return (
    <div className="flex flex-col gap-1.5" data-testid="relay-turn">
      <StatTile
        label={t('relay.admin.turn.title')}
        value={view.allocations ?? t(view.stateKey)}
        sub={
          view.allocations === null
            ? t(view.modeKey)
            : t('relay.admin.turn.sub', { mode: t(view.modeKey), state: t(view.stateKey) })
        }
        hint={t('relay.admin.turn.hint')}
        tone={view.tone}
        stale={stale}
        data-testid="relay-metric-turn"
      />
      <RelayTurnDetails view={view} />
    </div>
  );
}

/** 磁贴下的明细行。单独导出，供静态渲染的单测直接断言。 */
export function RelayTurnDetails({ view }: { view: RelayTurnView }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
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
