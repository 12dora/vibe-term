// 本机卡「接入 Hub」面板：本机的两个地址、当前挂载的 Hub、Hub 列表与两条上级提示。
//
// standalone 下换成开启 Hub 的向导；本机已经接入中继时这里只留一句说明——同一台机器不会
// 同时挂 Hub 和中继，摆一份可操作的 Hub 版式只会让人以为能两边都连。

import type { HubFailureReason } from '@/node/hub-load-coordinator';
import type { MeshHubsState } from '@/node/mesh-hubs';
import { writerHub } from '@/node/mesh-hubs';
import type { HubMode, MeshHubEndpoint } from '@tmex/api-client/auth/index';
import type { LocalRole, LocalStatusResponse } from '@tmex/api-client/local/types';
import { cn } from '@tmex/ui';
import { Button } from '@tmex/ui/button';
import { Loader2, Repeat, ShieldAlert, TriangleAlert } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CopyableValue, Row } from '../copy-feedback';
import type { SetupIntent } from '../membership/intent';
import { HubSetupWizard } from '../setup/hub-setup-wizard';
import {
  HubModeTag,
  candidateFailure,
  hubChipTitle,
  hubLabel,
  hubModeLabel,
  indexCandidates,
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
  /** hub 管理面是否应答（`useHubNode`）；中继模式与 standalone 下不看。 */
  hubOnline: boolean;
  /** 首次探测是否仍在飞（含 401 → 静默登录 → 重试）；只用来区分「还没结论」与「连不上」。 */
  hubLoading: boolean;
  hubFailure: HubFailureReason | null;
  /** 本机走中继：这里只给一句说明，改回 Hub 要先在中继那边离开。 */
  relayMode: boolean;
  standalone: boolean;
  changeHubDisabled: boolean;
  onChangeHub: () => void;
  /** standalone 下预选的向导路径；换一条要换 key 重新挂。 */
  wizardPath: SetupIntent | null;
}

export function HubUplinkPanel(props: HubUplinkPanelProps) {
  const { t } = useTranslation();
  if (props.relayMode) {
    return (
      <p
        className="flex items-center gap-1.5 rounded-lg bg-muted/60 p-2 text-xs text-muted-foreground"
        data-testid="local-uplink-hub-blocked"
      >
        <ShieldAlert className="size-3.5 shrink-0" />
        {t('nodes.machine.uplinkHubBlocked')}
      </p>
    );
  }
  if (props.standalone) return <HubSetupSlot status={props.status} wizardPath={props.wizardPath} />;
  return <HubMembershipRows {...props} />;
}

/** 角色选择器在卡片上半部分，选完要把向导带进视野，否则看着像什么都没发生。 */
function HubSetupSlot({
  status,
  wizardPath,
}: {
  status: LocalStatusResponse;
  wizardPath: SetupIntent | null;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (wizardPath) ref.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [wizardPath]);
  return (
    <div ref={ref}>
      {/* `initialPath` 只在首次挂载时生效，改路径必须换 key 重新挂一次。 */}
      <HubSetupWizard key={wizardPath ?? 'default'} localStatus={status} initialPath={wizardPath} />
    </div>
  );
}

/**
 * 本机的两个地址：
 * - 「本机地址」= `hubPublicUrl`，只有 hub 角色才有，是别人访问本机的地址；
 * - 「当前 Hub」= 真正挂载的那台 hub。`/api/local/status` 的 `hubUrl` 只是入会时写死的拨号种子，
 *   主备切换后早已不是当前挂载的那台，界面上不展示它，只用来判断这一行要不要渲染。
 */
/**
 * 本机的主 / 备身份：`/api/local/status` 不下发 hubMode，只能从 hub 集合里按自身 nodeId 取。
 * 集合里没有本机（旧入口、集合还没拉到）时返回 `null`，不做任何猜测。
 */
function selfHubMode(
  hubs: MeshHubsState,
  localRole: LocalRole,
  selfNodeId: string | null
): HubMode | null {
  if (localRole !== 'hub,node') return null;
  return hubs.hubs.find((hub) => hub.nodeId && hub.nodeId === selfNodeId)?.mode ?? null;
}

function HubMembershipRows({
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
  const { t } = useTranslation();
  const meshRole = localRole === 'node' || localRole === 'hub,node';
  const localHubMode = selfHubMode(hubs, localRole, selfNodeId);
  const attached: AttachedHubView = meshRole
    ? resolveAttachedHub(hubs, selfNodeId)
    : { kind: 'none' };
  return (
    <div className="flex flex-col gap-3">
      {localHubMode && (
        <Row label={t('nodes.hubs.machineRole')}>
          <span className="text-xs" data-testid="local-machine-hub-mode">
            {hubModeLabel(t, localHubMode)}
          </span>
        </Row>
      )}
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
      <p
        className="flex items-center gap-1.5 rounded-lg bg-muted/60 p-2 text-xs text-muted-foreground"
        data-testid="nodes-hub-standby"
      >
        <ShieldAlert className="size-3.5 shrink-0" />
        {t('nodes.hubs.standbyNotice')}
      </p>
    );
  }
  if (hubOnline) return null;
  if (hubFailure) {
    const notice = hubFailureNotice(hubFailure);
    return (
      <p
        className="flex items-center gap-1.5 rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
        data-testid={notice.testId}
      >
        <ShieldAlert className="size-3.5 shrink-0" />
        {t(notice.key, notice.params)}
      </p>
    );
  }
  // 行数与红条一致，出结论时不跳版。
  if (hubLoading) {
    return (
      <p
        className="flex items-center gap-1.5 rounded-lg bg-muted/60 p-2 text-xs text-muted-foreground"
        data-testid="nodes-hub-connecting"
      >
        <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
        {t('nodes.hubConnecting')}
      </p>
    );
  }
  return null;
}

/** 别人访问本机 hub 用的地址；没设置时说清后果，指回角色设置。 */
function LocalAddressRow({ publicUrl }: { publicUrl: string | null }) {
  const { t } = useTranslation();
  return (
    <Row label={t('nodes.machine.localAddress')}>
      {publicUrl ? (
        <CopyableValue value={publicUrl} testId="local-machine-local-address" />
      ) : (
        <span className="flex flex-wrap items-center gap-2 text-xs">
          <span data-testid="local-machine-local-address-unset">
            {t('nodes.machine.localAddressUnset')}
          </span>
          <span className="text-muted-foreground">{t('nodes.machine.localAddressHint')}</span>
        </span>
      )}
    </Row>
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
 * Hub 列表：一台一枚 chip。写入归属、挂载关系与最近一次连接失败都收进悬浮详情，
 * chip 本体只留「名字 + 主 / 备 + 离线」——这一份列表同时顶替了原来的 Hub 集群条。
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
            failure={candidateFailure(hub, byUrl)}
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
  failure,
}: {
  hub: MeshHubEndpoint;
  attached: boolean;
  writer: boolean;
  failure: MeshHubsState['candidates'][number] | null;
}) {
  const { t } = useTranslation();
  const offline = hub.online === false;
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
        attached ? 'border-primary/50 bg-primary/5' : 'border-border/60'
      )}
      title={hubChipTitle(t, hub, attached, failure, writer)}
      data-testid={`local-machine-hub-item-${hub.nodeId}`}
      data-hub-mode={hub.mode}
      data-hub-online={offline ? 'false' : 'true'}
      data-hub-attached={attached ? 'true' : 'false'}
      data-hub-writer={writer ? 'true' : 'false'}
      data-hub-failing={failure ? 'true' : 'false'}
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
      {failure && (
        <TriangleAlert
          className="size-3 shrink-0 text-amber-500"
          data-testid={`local-machine-hub-warning-${hub.nodeId}`}
          aria-hidden
        />
      )}
    </span>
  );
}
