// Hub 控制面失守时的三条恢复提示：CA 变更、未准入、双主。
//
// 这三种情况**网页里一步都修不了**：修复动作全在节点自己的操作系统 shell 里。所以每条提示
// 都必须把可直接粘贴的整条命令摆出来（地址与指纹已代入），而不是只丢一句「连接失败」。
//
// 版式不复用 `Notice`：那是一行式的 `<p>`，而这里每条都带指纹行与命令块，塞进 `<p>` 是非法嵌套。

import type { MeshHubCandidate } from '@/node/mesh-hubs';
import type { MeshHubEndpoint } from '@vibeterm/api-client/auth/index';
import { ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CopyButton, CopyableCode } from '../copy-feedback';
import { hubLabel, normalizeHubUrl } from './hub-strip';

/**
 * hub 拒登本节点证书时，节点这一侧记下的原因。
 *
 * hub 自己打的日志是 `cert_not_admitted`，但传到节点的是 ws 拆链原因，归一化之后落在
 * `auth_rejected`（见 `uplink-reconnect.ts` 的分类规则）。两个值都要认：只认前者的话，
 * 现网最常见的那一种（hub 重装）永远不出提示。
 */
const NOT_ADMITTED_ERRORS = new Set(['cert_not_admitted', 'auth_rejected']);

/** 指纹短形：SHA256 SPKI 是 64 位小写 hex，行内只摆前 16 位，完整值走 title 与复制。 */
export const FINGERPRINT_SHORT_LEN = 16;

export function shortFingerprint(value: string): string {
  return value.length > FINGERPRINT_SHORT_LEN ? `${value.slice(0, FINGERPRINT_SHORT_LEN)}…` : value;
}

/** 核对指纹用的命令，在 **hub** 上执行。 */
export const HUB_CA_FINGERPRINT_COMMAND = 'vibeterm hub ca fingerprint';

/** 双主时把其中一台退为备 hub，在**那台 hub** 上执行。 */
export const HUB_DEMOTE_COMMAND = 'vibeterm hub demote';

/** 指纹核对无误后更新本机 pin，在**本节点**执行。 */
export function trustRefreshCommand(hubUrl: string, fingerprint: string): string {
  return `vibeterm hub trust refresh ${normalizeHubUrl(hubUrl)} --fingerprint ${fingerprint}`;
}

/** 用新的加入码 / 密码重新加入，在**本节点**执行。 */
export function hubJoinCommand(hubUrl: string): string {
  return `vibeterm hub join ${normalizeHubUrl(hubUrl)}`;
}

export interface HubCaMismatchRow {
  publicUrl: string;
  advertised: string;
  pinned: string;
}

/** 广播的 CA 指纹与本机 pin 不一致的候选；旧后端不下发 `caMismatch` 时为空。 */
export function caMismatchRows(candidates: MeshHubCandidate[]): HubCaMismatchRow[] {
  return candidates.flatMap((candidate) =>
    candidate.caMismatch
      ? [
          {
            publicUrl: candidate.publicUrl,
            advertised: candidate.caMismatch.advertised,
            pinned: candidate.caMismatch.pinned,
          },
        ]
      : []
  );
}

/**
 * 证书被 hub 拒绝的候选地址。
 *
 * 已经判成 CA 变更的那一条不再重复计入：那时候连 TLS 都没握完，谈不上准入，
 * 两条提示一起出只会让人先去重新加入，白跑一趟。
 */
export function notAdmittedUrls(candidates: MeshHubCandidate[]): string[] {
  return candidates
    .filter(
      (candidate) =>
        !candidate.caMismatch &&
        candidate.lastError !== null &&
        NOT_ADMITTED_ERRORS.has(candidate.lastError)
    )
    .map((candidate) => candidate.publicUrl);
}

/**
 * 双主：两台以上 active 且写入纪元相同。
 *
 * 纪元不同不算——那正是主备切换的正常形态（新主纪元更高，旧主还没收到降级）。
 * 相同纪元才意味着两边都认为自己收写入，谁也围栏不了谁。
 */
export function splitBrainHubs(hubs: MeshHubEndpoint[]): MeshHubEndpoint[] {
  const byEpoch = new Map<number, MeshHubEndpoint[]>();
  for (const hub of hubs) {
    if (hub.mode !== 'active') continue;
    const group = byEpoch.get(hub.writerEpoch);
    if (group) group.push(hub);
    else byEpoch.set(hub.writerEpoch, [hub]);
  }
  let worst: MeshHubEndpoint[] = [];
  for (const group of byEpoch.values()) {
    if (group.length > worst.length) worst = group;
  }
  return worst.length >= 2 ? worst : [];
}

const BLOCK_CLASS =
  'flex flex-col gap-2 rounded-lg bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400';

function RecoveryBlock({
  testId,
  title,
  description,
  children,
}: {
  testId: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className={BLOCK_CLASS} data-testid={testId}>
      <span className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="font-medium">{title}</span>
          <span className="ml-1">{description}</span>
        </span>
      </span>
      {children}
    </div>
  );
}

function FingerprintLine({
  label,
  value,
  testId,
}: { label: string; value: string; testId: string }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className="w-16 shrink-0 opacity-80">{label}</span>
      <code
        className="min-w-0 break-all rounded bg-background/60 px-1.5 py-0.5 font-mono text-[11px]"
        title={value}
        data-testid={testId}
      >
        {shortFingerprint(value)}
      </code>
      <CopyButton value={value} testId={testId} />
    </span>
  );
}

function CaMismatchNotice({ row }: { row: HubCaMismatchRow }) {
  const { t } = useTranslation();
  return (
    <RecoveryBlock
      testId="nodes-hub-ca-changed"
      title={t('nodes.hubs.caChanged.title')}
      description={t('nodes.hubs.caChanged.description', { hub: normalizeHubUrl(row.publicUrl) })}
    >
      <span className="flex flex-col gap-1 pl-5">
        <FingerprintLine
          label={t('nodes.hubs.caChanged.advertised')}
          value={row.advertised}
          testId="nodes-hub-ca-advertised"
        />
        <FingerprintLine
          label={t('nodes.hubs.caChanged.pinned')}
          value={row.pinned}
          testId="nodes-hub-ca-pinned"
        />
      </span>
      {/* 两条命令的执行位置不同：核对指纹在 hub 上，更新 pin 在本节点上，各自成块不合并。 */}
      <div className="pl-5">
        <CopyableCode
          label={t('nodes.hubs.caChanged.verify')}
          value={HUB_CA_FINGERPRINT_COMMAND}
          testId="nodes-hub-ca-fingerprint-command"
        />
      </div>
      <div className="pl-5">
        <CopyableCode
          label={t('nodes.hubs.caChanged.commandLabel')}
          value={trustRefreshCommand(row.publicUrl, row.advertised)}
          testId="nodes-hub-ca-command"
        />
      </div>
    </RecoveryBlock>
  );
}

function NotAdmittedNotice({ publicUrl }: { publicUrl: string }) {
  const { t } = useTranslation();
  return (
    <RecoveryBlock
      testId="nodes-hub-not-admitted"
      title={t('nodes.hubs.notAdmitted.title')}
      description={t('nodes.hubs.notAdmitted.description', { hub: normalizeHubUrl(publicUrl) })}
    >
      <div className="pl-5">
        <CopyableCode
          label={t('nodes.hubs.notAdmitted.commandLabel')}
          value={hubJoinCommand(publicUrl)}
          testId="nodes-hub-join-command"
        />
      </div>
    </RecoveryBlock>
  );
}

/**
 * 「连接」段 Hub 形态末尾的恢复提示。候选一条问题都没有时整块不渲染。
 *
 * 同一台 hub 只出一条：CA 变更优先于未准入（`notAdmittedUrls` 已把它排掉）。
 */
export function HubRecoveryNotices({ candidates }: { candidates: MeshHubCandidate[] }) {
  const mismatches = caMismatchRows(candidates);
  const notAdmitted = notAdmittedUrls(candidates);
  if (mismatches.length === 0 && notAdmitted.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="nodes-hub-recovery">
      {mismatches.map((row) => (
        <CaMismatchNotice key={row.publicUrl} row={row} />
      ))}
      {notAdmitted.map((url) => (
        <NotAdmittedNotice key={url} publicUrl={url} />
      ))}
    </div>
  );
}

/** 双主横幅：常驻节点页顶部，不可关闭——分叉期间每一次管理写入都可能落错地方。 */
export function HubSplitBrainBanner({ hubs }: { hubs: MeshHubEndpoint[] }) {
  const { t } = useTranslation();
  const conflicting = splitBrainHubs(hubs);
  if (conflicting.length === 0) return null;
  const first = conflicting[0];
  if (!first) return null;
  return (
    <RecoveryBlock
      testId="nodes-hub-split-brain"
      title={t('nodes.hubs.splitBrain.title')}
      description={t('nodes.hubs.splitBrain.description', {
        hubs: conflicting.map(hubLabel).join(' · '),
        epoch: first.writerEpoch,
      })}
    >
      <div className="pl-5">
        <CopyableCode
          label={t('nodes.hubs.splitBrain.commandLabel')}
          value={HUB_DEMOTE_COMMAND}
          testId="nodes-hub-demote-command"
        />
      </div>
    </RecoveryBlock>
  );
}
