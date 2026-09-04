// 「连接」段的 Hub 形态：本机对外地址（hub 兼节点）、当前挂载的 Hub、Hub 列表与上级提示。
//
// 优先级、写入纪元、授权来源与最近失败原因一律不在这里出现：它们全都收进「连接详情」，
// 这一段只回答「现在连着谁、能不能写」。

import type { HubFailureReason } from '@/node/hub-load-coordinator';
import type { MeshHubsState } from '@/node/mesh-hubs';
import { writerHub } from '@/node/mesh-hubs';
import type { MeshHubEndpoint } from '@tmex/api-client/auth/index';
import type { LocalRole, LocalStatusResponse } from '@tmex/api-client/local/types';
import { cn } from '@tmex/ui';
import { Button } from '@tmex/ui/button';
import { Repeat, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../card-parts';
import { CopyableValue, Row } from '../copy-feedback';
import {
  HubModeTag,
  candidateFailure,
  hubLabel,
  hubModeLabel,
  indexCandidates,
  normalizeHubUrl,
} from './hub-strip';

/** hub 管理面不可用时那一行提示的文案位置。 */
export interface HubNoticeCopy {
  testId: string;
  key: string;
  params?: Record<string, string>;
}

/**
 * hub 应答了、只是不认这次身份（通行密钥 / TOTP / 未登录）与 hub 根本打不通是两回事：
 * 前者要用户重新登录，说成「Hub 不可达」只会把人引向错误的排查。
 */
export function hubFailureNotice(failure: HubFailureReason | null): HubNoticeCopy {
  if (failure?.kind === 'auth') {
    return {
      testId: 'nodes-hub-login-rejected',
      key: 'nodes.hubLoginRejected',
      params: { code: failure.code },
    };
  }
  return { testId: 'nodes-hub-offline', key: 'nodes.hubOffline' };
}

/** 「当前 Hub」这一行要摆的东西：集合里的那一行 / 只知道地址 / 压根没连上。 */
export type AttachedHubView =
  | { kind: 'hub'; hub: MeshHubEndpoint; isSelf: boolean }
  | { kind: 'url'; url: string }
  | { kind: 'none' };

/**
 * 本机挂载的那台 hub。**只认 uplink 的挂载事实**（`attached`）：`hubUrl` 是入会时写死的种子，
 * 主备切换或退出之后早已不是当前挂载的那台，拿它充数会让一台没连上的机器显示得像连着。
 *
 * 集合里查不到挂载的那一行（刚切过去、集合还没拉到）时退回挂载信息自带的地址；
 * 没有 uplink 的 hub 兼节点就是挂在自己身上，取集合里的本机那一行。
 */
export function resolveAttachedHub(
  snapshot: MeshHubsState,
  selfNodeId: string | null
): AttachedHubView {
  const attached = snapshot.attached;
  if (attached?.hubNodeId) {
    const row = snapshot.hubs.find((hub) => hub.nodeId === attached.hubNodeId);
    if (row) return { kind: 'hub', hub: row, isSelf: row.nodeId === selfNodeId };
    return attached.publicUrl ? { kind: 'url', url: attached.publicUrl } : { kind: 'none' };
  }
  const self = selfNodeId ? snapshot.hubs.find((hub) => hub.nodeId === selfNodeId) : undefined;
  return self ? { kind: 'hub', hub: self, isSelf: true } : { kind: 'none' };
}

/** 当前挂载的那台 hub 的往返延迟；候选记录里没有（旧后端 / 还没探过）时为 `null`。 */
export function attachedHubRtt(snapshot: MeshHubsState): number | null {
  const url = snapshot.attached?.publicUrl;
  if (!url) return null;
  const rtt = indexCandidates(snapshot.candidates).get(normalizeHubUrl(url))?.rttMs;
  return typeof rtt === 'number' ? rtt : null;
}

/** 列表次序：writer 打头，其余按优先级——用户先看的是「谁收写入」。 */
export function orderHubs(hubs: MeshHubEndpoint[], writerHubId: string | null): MeshHubEndpoint[] {
  return [...hubs].sort((a, b) => {
    const rank = (hub: MeshHubEndpoint) => (hub.nodeId === writerHubId ? 0 : 1);
    return rank(a) - rank(b) || a.priority - b.priority;
  });
}

export interface HubUplinkPanelProps {
  localRole: LocalRole;
  selfNodeId: string | null;
  status: LocalStatusResponse;
  hubs: MeshHubsState & { writesBlocked: boolean };
  /** hub 管理面是否应答（`useHubNode`）。 */
  hubOnline: boolean;
  /** 首次探测是否仍在飞（含 401 → 静默登录 → 重试）；只用来区分「还没结论」与「连不上」。 */
  hubLoading: boolean;
  hubFailure: HubFailureReason | null;
  changeHubDisabled: boolean;
  onChangeHub: () => void;
}

export function HubUplinkPanel({
  localRole,
  selfNodeId,
  status,
  hubs,
  hubOnline,
  hubLoading,
  hubFailure,
  changeHubDisabled,
  onChangeHub,
}: HubUplinkPanelProps) {
  const meshRole = localRole === 'node' || localRole === 'hub,node';
  const attached: AttachedHubView = meshRole
    ? resolveAttachedHub(hubs, selfNodeId)
    : { kind: 'none' };
  return (
    <div className="flex flex-col gap-3" data-testid="local-uplink-hub-panel">
      {localRole === 'hub,node' && <LocalAddressRow publicUrl={status.hubPublicUrl} />}
      {meshRole && (attached.kind !== 'none' || status.hubUrl) && (
        <CurrentHubRow
          attached={attached}
          writer={writerHub(hubs)}
          {...(localRole === 'node'
            ? { changeHub: { disabled: changeHubDisabled, onChange: onChangeHub } }
            : {})}
        />
      )}
      {meshRole && hubs.hubs.length >= 2 && (
        <MachineHubList
          hubs={orderHubs(hubs.hubs, hubs.writerHubId)}
          attachedHubId={hubs.attached?.hubNodeId ?? null}
          writerHubId={hubs.writerHubId}
          candidates={hubs.candidates}
        />
      )}
      {meshRole && (
        <HubUplinkNotices
          hubOnline={hubOnline}
          hubLoading={hubLoading}
          writesBlocked={hubs.writesBlocked}
          hubFailure={hubFailure}
        />
      )}
    </div>
  );
}

/**
 * 上级 hub 的提示分档：拒写 → 拒登 / 打不通 → 首次探测在飞。
 *
 * 「还没探过」与「探过、连不上」必须分开：`online` 的初值就是 false，把它当成打不通的话，
 * 每次进节点管理都会先闪一条红条，等第一次 `GET /api/hub/nodes`（可能先 401、静默登录再重试）
 * 回来才消失。所以红条只认已经落地的 `hubFailure`，在飞时只给一句灰字。
 */
export function HubUplinkNotices({
  hubOnline,
  hubLoading,
  writesBlocked,
  hubFailure,
}: {
  hubOnline: boolean;
  hubLoading: boolean;
  writesBlocked: boolean;
  hubFailure: HubFailureReason | null;
}) {
  const { t } = useTranslation();
  // 主 hub 掉线时「hub 不可达」与「备 hub 拒写」说的是同一件事，只留更具体的那一条。
  if (writesBlocked) {
    return (
      <Notice tone="muted" testId="nodes-hub-standby">
        {t('nodes.hubs.standbyNotice')}
      </Notice>
    );
  }
  if (hubOnline) return null;
  if (hubFailure) {
    const notice = hubFailureNotice(hubFailure);
    return (
      <Notice tone="danger" testId={notice.testId}>
        {t(notice.key, notice.params)}
      </Notice>
    );
  }
  // 行数与红条一致，出结论时不跳版。
  if (hubLoading) {
    return (
      <Notice tone="muted" testId="nodes-hub-connecting" spinner>
        {t('nodes.hubConnecting')}
      </Notice>
    );
  }
  return null;
}

/** 别人访问本机 hub 用的地址；没设置时说清后果，指回角色菜单。 */
function LocalAddressRow({ publicUrl }: { publicUrl: string | null }) {
  const { t } = useTranslation();
  return (
    <Row label={t('nodes.machine.localAddress')}>
      {publicUrl ? (
        <CopyableValue value={publicUrl} testId="local-machine-local-address" />
      ) : (
        <UnsetAddress
          hint={t('nodes.machine.localAddressHint')}
          testId="local-machine-local-address"
        />
      )}
    </Row>
  );
}

/** 地址还没配好：先说「未设置」，再一句说清后果与去哪儿改。中继服务那一段共用它。 */
export function UnsetAddress({ hint, testId }: { hint: string; testId: string }) {
  const { t } = useTranslation();
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs">
      <span data-testid={`${testId}-unset`}>{t('nodes.machine.localAddressUnset')}</span>
      <span className="text-muted-foreground">{hint}</span>
    </span>
  );
}

function CurrentHubRow({
  attached,
  writer,
  changeHub,
}: {
  attached: AttachedHubView;
  writer: MeshHubEndpoint | null;
  changeHub?: { disabled: boolean; onChange: () => void };
}) {
  const { t } = useTranslation();
  // 挂在备 hub 上时写入其实落在别处，同一行补出 writer，省得用户去 hub 管理面对照。
  const elsewhere =
    attached.kind === 'hub' && writer && writer.nodeId !== attached.hub.nodeId ? writer : null;
  return (
    <Row label={t('nodes.machine.currentHub')}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {attached.kind === 'hub' && (
          <>
            <span
              className="flex items-center gap-1.5 text-xs"
              data-testid="local-machine-attached-hub"
            >
              <span className="font-medium">
                {attached.isSelf ? t('nodes.machine.self') : hubLabel(attached.hub)}
              </span>
              <HubModeTag mode={attached.hub.mode} testId="local-machine-attached-hub-mode" />
            </span>
            {!attached.isSelf && (
              <CopyableValue
                value={attached.hub.publicUrl}
                testId="local-machine-attached-hub-url"
              />
            )}
          </>
        )}
        {attached.kind === 'url' && (
          <CopyableValue value={attached.url} testId="local-machine-attached-hub-url" />
        )}
        {attached.kind === 'none' && (
          <span className="text-xs" data-testid="local-machine-hub-disconnected">
            {t('nodes.machine.hubDisconnected')}
          </span>
        )}
        {elsewhere && (
          <span className="text-xs text-muted-foreground" data-testid="local-machine-writer-hub">
            {t('nodes.machine.writerHub', { name: hubLabel(elsewhere) })}
          </span>
        )}
        {changeHub && (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={changeHub.disabled}
            onClick={changeHub.onChange}
            data-testid="local-machine-change-hub"
          >
            <Repeat />
            {t('nodes.membership.changeHub')}
          </Button>
        )}
      </div>
    </Row>
  );
}

/**
 * Hub 列表：一台一枚 chip，只留「名字 + 主 / 备 + 离线 + 连不上的警示」。
 * 优先级、纪元、授权与最近错误都在「连接详情」里逐条摆出来，不再塞进悬浮详情。
 */
export function MachineHubList({
  hubs,
  attachedHubId,
  writerHubId,
  candidates = [],
}: {
  hubs: MeshHubEndpoint[];
  attachedHubId: string | null;
  writerHubId: string | null;
  candidates?: MeshHubsState['candidates'];
}) {
  const { t } = useTranslation();
  const byUrl = indexCandidates(candidates);
  return (
    <Row label={t('nodes.machine.hubList')}>
      <span className="flex flex-wrap items-center gap-1.5" data-testid="local-machine-hub-list">
        {hubs.map((hub) => (
          <MachineHubChip
            key={hub.nodeId}
            hub={hub}
            attached={hub.nodeId === attachedHubId}
            writer={hub.nodeId === writerHubId}
            failing={candidateFailure(hub, byUrl) !== null}
          />
        ))}
      </span>
    </Row>
  );
}

function MachineHubChip({
  hub,
  attached,
  writer,
  failing,
}: {
  hub: MeshHubEndpoint;
  attached: boolean;
  writer: boolean;
  failing: boolean;
}) {
  const { t } = useTranslation();
  const offline = hub.online === false;
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
        attached ? 'border-primary/50 bg-primary/5' : 'border-border/60'
      )}
      data-testid={`local-machine-hub-item-${hub.nodeId}`}
      data-hub-mode={hub.mode}
      data-hub-online={offline ? 'false' : 'true'}
      data-hub-attached={attached ? 'true' : 'false'}
      data-hub-writer={writer ? 'true' : 'false'}
      data-hub-failing={failing ? 'true' : 'false'}
    >
      <span className="truncate font-medium">{hubLabel(hub)}</span>
      <span className="text-muted-foreground">{hubModeLabel(t, hub.mode)}</span>
      {offline && (
        <span
          className="text-muted-foreground"
          data-testid={`local-machine-hub-offline-${hub.nodeId}`}
        >
          {t('nodes.hubs.offline')}
        </span>
      )}
      {failing && (
        <TriangleAlert
          className="size-3 shrink-0 text-amber-500"
          data-testid={`local-machine-hub-warning-${hub.nodeId}`}
          aria-hidden
        />
      )}
    </span>
  );
}
