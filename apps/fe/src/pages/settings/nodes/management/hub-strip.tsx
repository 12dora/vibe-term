// Hub 集群条：一台 hub 一枚 chip，标出主 / 备、在线态、谁收写入、本入口挂在哪一台。
//
// 只有两台及以上 hub 才渲染：单 hub 用户（绝大多数）看到的版式与多 hub 之前完全一致。

import type { HubEndpointInfo, HubMode } from '@tmex/api-client/auth/index';
import { cn } from '@tmex/ui';
import { Link2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 主 / 备的文案键；旧后端不下发 mode 时退回通用的「Hub」。 */
export function hubModeLabel(t: Translate, mode: HubMode | null): string {
  if (mode === 'active') return t('nodes.hubs.active');
  if (mode === 'standby') return t('nodes.hubs.standby');
  return t('nodes.hub');
}

/** chip 与表内徽标共用的悬浮详情：地址、优先级、写入纪元、在线态。 */
export function hubDetailText(t: Translate, hub: HubEndpointInfo, attached: boolean): string {
  const detail = t('nodes.hubs.detail', {
    url: hub.publicUrl,
    priority: hub.priority,
    epoch: hub.writerEpoch,
    state: t(hub.online === false ? 'nodes.hubs.offline' : 'nodes.hubs.online'),
  });
  return attached ? `${detail}\n${t('nodes.hubs.attached')}` : detail;
}

/** hub 的短名：没有名字时用 nodeId 前 8 位，与指纹列的读法一致。 */
function hubLabel(hub: HubEndpointInfo): string {
  return hub.name || hub.nodeId.slice(0, 8);
}

export function HubStrip({
  hubs,
  attachedHubId,
  writerHubId,
}: {
  hubs: HubEndpointInfo[];
  attachedHubId: string | null;
  writerHubId: string | null;
}) {
  const { t } = useTranslation();
  if (hubs.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="nodes-hub-strip">
      <span className="text-[11px] text-muted-foreground">{t('nodes.hubs.title')}</span>
      {hubs.map((hub) => (
        <HubChip
          key={hub.nodeId}
          hub={hub}
          attached={hub.nodeId === attachedHubId}
          writer={hub.nodeId === writerHubId}
        />
      ))}
    </div>
  );
}

function HubChip({
  hub,
  attached,
  writer,
}: { hub: HubEndpointInfo; attached: boolean; writer: boolean }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
        attached ? 'border-primary/50 bg-primary/5' : 'border-border/60'
      )}
      title={hubDetailText(t, hub, attached)}
      data-testid={`nodes-hub-chip-${hub.nodeId}`}
      data-hub-mode={hub.mode}
      data-hub-attached={attached ? 'true' : 'false'}
      data-hub-writer={writer ? 'true' : 'false'}
    >
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          hub.online === false ? 'bg-muted-foreground/40' : 'bg-emerald-500'
        )}
      />
      <span className="truncate font-medium">{hubLabel(hub)}</span>
      <span className="text-muted-foreground">{hubModeLabel(t, hub.mode)}</span>
      {writer && (
        <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
          {t('nodes.hubs.writer')}
        </span>
      )}
      {attached && <Link2 className="size-3 shrink-0 text-primary" aria-hidden />}
    </span>
  );
}
