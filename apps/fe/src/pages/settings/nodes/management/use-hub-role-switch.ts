// Hub 主备切换：从节点表里把某台 hub 升成主（writer），或把当前主降成备。
//
// 一次切换最多四步，顺序不能反：
//   1. 目标还不是签名授权（`authorization !== 'signed'`）→ 先签一条 `admit-hub` 并等它生效。
//      hub 授权的权威来源是 key log，env 只是 bootstrap；不签授权直接升主，目标会以
//      `HUB_NOT_AUTHORIZED` 拒绝。
//   2. 原主可达 → 先把它降成备。它不可达时跳过这一步，靠更高的 writerEpoch 围栏它——
//      纪元只增不减，旧主带着低纪元回来只会被 fence 成 standby。
//   3. 目标升主。**纪元不由前端算**：入口看到的 hub 集合可能不全，算出来的 `max+1` 反而会被
//      目标以 `HUB_EPOCH_STALE` 拒掉，而那时旧主已经降备，集群就没人写了。请求只带
//      `mode: 'active'`，由目标自己取 `max(已知纪元)+1`。
//   4. 目标落库后**自己重启**，`/n/<目标>/api/...` 会断一段时间：轮询 `roleStatus` 时把不可达
//      当成「重启中」继续等，只有超出预算才判失败；随后再等入口的 `/api/mesh/hubs` 把
//      `writerHubId` 换成目标，这才算真的接管了写入。
//
// 「降原主」和「升目标」之间有一个集群没有 writer 的窗口，切换又跨越目标的一次重启，用户很可能
// 在中途刷新页面：**任何一个改动请求发出去之前**先把 `{operationId, targetHubId, fromHubId,
// intent, phase}` 落 sessionStorage，刷新后按 phase 接着跑（含重发那条幂等的升主请求）。
// 原主已降备之后，升主失败、超时未确认、途中抛异常都不只弹一条 toast——那会让集群悄悄停在
// 没有 writer 的状态——而是留一个不会自动消失的恢复对话框，让用户重试目标或回滚回原主，
// 续跑记录也一并留着，直到用户选出结果。
// 记录只在这一个标签页里，换标签页看不到：它不是锁，只是「刷新即丢」的补丁。

import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import { headFromResponse } from '@/auth/key-log-actions';
import type { RecordSigner } from '@/auth/key-log-actions';
import { buildAdmitHubRecord } from '@/node/enrollment';
import { withKeyLogLock } from '@/node/enrollment-engine';
import type { NodeRow } from '@/node/mesh-nodes';
import type { AuthApi, MeshHubEndpoint } from '@tmex/api-client/auth/index';
import { requireRootEpoch } from '@tmex/api-client/auth/index';
import type { KeyLogHead } from '@tmex/shared/auth';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  type AdmitHubOutcome,
  type HubRef,
  type HubRoleButtonState,
  type HubRoleIo,
  type HubRoleSwitchPlan,
  type Translate,
  type UnsupportedKeyLogNode,
  createHubRoleIo,
  hubRoleButtonState,
  planHubRoleSwitch,
} from './hub-role-switch-model';
import {
  type HubRoleRecoverContext,
  type HubRoleRunContext,
  type HubRoleRunOutcome,
  type HubRoleSwitchPhase,
  admitHubWithForce,
  clearHubRoleSwitch,
  guardHubRoleRun,
  hubRoleSwitchPersist,
  loadHubRoleSwitch,
  promoteHub,
  resumeHubRoleSwitch,
  runHubRoleSwitch,
} from './hub-role-switch-run';
import type { ResolvedMode } from './types';

// 模型与状态机各自成文件，但调用方（节点表、确认框、单测）沿用这一个入口。
export * from './hub-role-switch-model';
export * from './hub-role-switch-run';

// ---------------------------------------------------------------------------
// operationId
// ---------------------------------------------------------------------------

const HEX = '0123456789abcdef';

/**
 * 后端按 RFC-4122 正则校验 `operationId`，而非安全上下文（http:// 的局域网入口）没有
 * `crypto.randomUUID`：用随机字节手搓一个 v4，版本位与变体位都补上。
 */
export function randomUuidV4(): string {
  const bytes = new Uint8Array(16);
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.getRandomValues === 'function') webCrypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  let hex = '';
  for (const byte of bytes) hex += HEX[byte >> 4] + HEX[byte & 0x0f];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function randomOperationId(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid;
  } catch {
    // 非安全上下文没有 randomUUID，退到手搓的 v4。
  }
  return randomUuidV4();
}

// ---------------------------------------------------------------------------
// React 绑定
// ---------------------------------------------------------------------------

export interface HubRoleForcePrompt {
  minVersion: string;
  nodes: UnsupportedKeyLogNode[];
}

/** 升主失败、集群暂时没有 writer 时摆在用户面前的两条出路。 */
export interface HubRoleRecoveryPrompt extends HubRoleRecoverContext {
  message: string;
  targetName: string;
  fromName: string;
}

export type HubRoleRecoveryChoice = 'retry' | 'rollback' | 'dismiss';

/** 一段切换结束后该把界面摆成什么样；抽出来是为了不必渲染组件就能验证收尾规则。 */
export interface HubRoleSettlement {
  /** 恢复对话框；`null` = 这一轮到此为止。 */
  recovery: HubRoleRecoveryPrompt | null;
  /** 仍算「切换中」：恢复框摆着的时候按钮继续禁用。 */
  running: boolean;
  /** 清掉续跑记录；恢复框还在就必须留着，刷新后仍能接着跑。 */
  clearRecord: boolean;
  toast: { level: 'success' | 'warning' | 'error'; message: string } | null;
  /** 让外部重新拉一次节点表。 */
  refresh: boolean;
}

export function hubRoleSettlement(p: {
  outcome: HubRoleRunOutcome;
  targetName: string;
  nameOf: (nodeId: string) => string;
  t: Translate;
}): HubRoleSettlement {
  const outcome = p.outcome;
  if (outcome.kind === 'recover') {
    // 集群此刻没有 writer：toast 会自己消失，这里必须留一个用户不点就不走的对话框。
    // 记录也留着，刷新后还能从 `promote` 那一档接着跑。
    return {
      recovery: {
        message: outcome.message,
        targetHubId: outcome.targetHubId,
        targetName: p.nameOf(outcome.targetHubId),
        fromHubId: outcome.fromHubId,
        fromName: p.nameOf(outcome.fromHubId),
      },
      running: true,
      clearRecord: false,
      toast: null,
      refresh: false,
    };
  }
  let toast: HubRoleSettlement['toast'] = null;
  if (outcome.kind === 'done') {
    toast = { level: 'success', message: p.t('nodes.hubs.role.done', { target: p.targetName }) };
  } else if (outcome.kind === 'unconfirmed') {
    toast = { level: 'warning', message: outcome.message };
  } else if (outcome.kind === 'failed') {
    toast = { level: 'error', message: outcome.message };
  }
  return {
    recovery: null,
    running: false,
    clearRecord: true,
    toast,
    refresh: outcome.kind !== 'cancelled',
  };
}

export interface HubRoleSwitchDeps {
  hubs: MeshHubEndpoint[];
  writerHubId: string | null;
  /** 名字取节点表那一份，确认框里写的与表里看到的是同一个名字。 */
  rows: NodeRow[];
  api: AuthApi;
  mode: ResolvedMode | null;
  prompt: CredentialPromptHandle;
  /** hub 当前接受管理写入；只影响需要签 `admit-hub` 的那一档。 */
  hubWritable: boolean;
}

export interface HubRoleSwitchController {
  /** 正在切换的 hub（目标 + 原主）：这些行显示「切换中」。 */
  switchingIds: ReadonlySet<string>;
  running: boolean;
  /** 待确认的计划；没有时为 `null`。 */
  plan: HubRoleSwitchPlan | null;
  /** 旧节点挡住 `admit-hub` 时的二次确认；没有时为 `null`。 */
  force: HubRoleForcePrompt | null;
  /** 升主失败后的恢复对话框；没有时为 `null`。 */
  recovery: HubRoleRecoveryPrompt | null;
  phase: HubRoleSwitchPhase | null;
  request: (row: NodeRow) => void;
  confirm: () => void;
  dismiss: () => void;
  resolveForce: (accepted: boolean) => void;
  resolveRecovery: (choice: HubRoleRecoveryChoice) => void;
  stateOf: (row: NodeRow, rowBusy: boolean) => HubRoleButtonState;
}

function showHubRoleToast(entry: NonNullable<HubRoleSettlement['toast']>): void {
  if (entry.level === 'success') toast.success(entry.message);
  else if (entry.level === 'warning') toast.warning(entry.message);
  else toast.error(entry.message);
}

export interface UseHubRoleSwitchOptions {
  io?: HubRoleIo;
  now?: () => number;
}

/** 续跑 effect 只在挂载时跑一次，它用到的东西一律走 ref（见 `useHubRoleRun`）。 */
interface HubRoleLatest {
  io: HubRoleIo;
  nameOf: (nodeId: string) => string;
  now: () => number;
  onChanged: () => void;
  t: Translate;
}

/**
 * 一段切换的运行态：起一段（`drive`）、收尾（`settle`）、以及刷新后按记录接着跑。
 * 全部依赖走 `latest` ref：把它们放进续跑 effect 的依赖数组，节点列表每刷新一次就会重跑
 * 这个 effect，cleanup 顺手把还在轮询的续跑掐掉。
 */
function useHubRoleRun(latest: { current: HubRoleLatest }) {
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<HubRoleSwitchPhase | null>(null);
  const [switchingIds, setSwitchingIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [recovery, setRecovery] = useState<HubRoleRecoveryPrompt | null>(null);
  const runRef = useRef<AbortController | null>(null);

  const settle = useCallback(
    (outcome: HubRoleRunOutcome, targetName: string) => {
      const cur = latest.current;
      const next = hubRoleSettlement({ outcome, targetName, nameOf: cur.nameOf, t: cur.t });
      if (next.toast) showHubRoleToast(next.toast);
      if (next.clearRecord) clearHubRoleSwitch();
      setRecovery(next.recovery);
      setPhase(null);
      if (!next.running) {
        setSwitchingIds(new Set<string>());
        setRunning(false);
      }
      if (next.refresh) cur.onChanged();
    },
    [latest]
  );

  /** 起一段切换：换掉上一段（若还在跑），并把「切换中」的行标出来。 */
  const drive = useCallback(
    (
      ids: Iterable<string>,
      targetName: string,
      task: (context: HubRoleRunContext) => Promise<HubRoleRunOutcome>
    ) => {
      runRef.current?.abort();
      const controller = new AbortController();
      runRef.current = controller;
      setRecovery(null);
      setRunning(true);
      setSwitchingIds(new Set(ids));
      // 恢复上下文由 task 途中交回来：抛异常时才知道该弹恢复框还是一条 toast。
      const recovered: { context: HubRoleRecoverContext | null } = { context: null };
      void (async () => {
        const outcome = await guardHubRoleRun({
          run: () =>
            task({
              signal: controller.signal,
              onRecoverContext: (context) => {
                recovered.context = context;
              },
            }),
          recover: () => recovered.context,
          t: latest.current.t,
        });
        if (controller.signal.aborted) return;
        settle(outcome, targetName);
      })();
    },
    [latest, settle]
  );

  /** 用户放弃这一轮（恢复框里选「不处理」）：掐掉续跑、清记录、界面回到空闲。 */
  const abandon = useCallback(() => {
    runRef.current?.abort();
    clearHubRoleSwitch();
    setRecovery(null);
    setSwitchingIds(new Set<string>());
    setPhase(null);
    setRunning(false);
  }, []);

  // 刷新页面时切换多半还卡在半路：按记录里的 phase 接着跑，不让用户对着一份「已完成」的假象。
  useEffect(() => {
    const cur = latest.current;
    const record = loadHubRoleSwitch(cur.now());
    if (record) {
      drive(
        record.fromHubId ? [record.targetHubId, record.fromHubId] : [record.targetHubId],
        cur.nameOf(record.targetHubId),
        ({ signal, onRecoverContext }) =>
          resumeHubRoleSwitch({
            record,
            io: cur.io,
            signal,
            phase: setPhase,
            persist: hubRoleSwitchPersist(record),
            t: cur.t,
            onRecoverContext,
          })
      );
    }
    return () => runRef.current?.abort();
  }, [drive, latest]);

  return { running, phase, setPhase, switchingIds, recovery, drive, abandon };
}

/** 旧节点挡住 `admit-hub` 时的二次确认：对话框的开关与它等着的那个 resolve。 */
function useHubRoleForce() {
  const [force, setForce] = useState<HubRoleForcePrompt | null>(null);
  const forceResolve = useRef<((accepted: boolean) => void) | null>(null);
  const resolveForce = useCallback((accepted: boolean) => {
    setForce(null);
    forceResolve.current?.(accepted);
    forceResolve.current = null;
  }, []);
  return { force, setForce, forceResolve, resolveForce };
}

/** 待确认的切换计划：点按钮时算一份出来，确认或取消后清掉。 */
function useHubRolePlan(
  hubs: MeshHubEndpoint[],
  writerHubId: string | null,
  nameOf: (nodeId: string) => string
) {
  const [plan, setPlan] = useState<HubRoleSwitchPlan | null>(null);
  const request = useCallback(
    (row: NodeRow) => {
      const next = planHubRoleSwitch({ row, hubs, writerHubId, nameOf });
      if (next) setPlan(next);
    },
    [hubs, nameOf, writerHubId]
  );
  const dismiss = useCallback(() => setPlan(null), []);
  return { plan, setPlan, request, dismiss };
}

/** 确认一份计划后要交给 `drive` 的几样东西：受影响的行、标题名、幂等 id 与续跑记录写入器。 */
function hubRoleSwitchRun(plan: HubRoleSwitchPlan, startedAt: number) {
  const target = plan.target;
  const operationId = randomOperationId();
  return {
    operationId,
    targetName: target?.name ?? plan.origin.name,
    ids: [
      plan.origin.nodeId,
      ...(target ? [target.nodeId] : []),
      ...(plan.from ? [plan.from.nodeId] : []),
    ],
    persist: hubRoleSwitchPersist({
      operationId,
      targetHubId: target?.nodeId ?? plan.origin.nodeId,
      fromHubId: plan.from?.nodeId ?? null,
      intent: target ? 'switch' : 'demoteOnly',
      startedAt,
    }),
  };
}

/**
 * 恢复框里的重试与回滚。两者都要一个新的 operationId：目标按 operationId 幂等，沿用旧的
 * 只会把那条失败记录原样还回来。回滚成功与否都保留同一套恢复上下文，用户可以来回换。
 */
function hubRoleRecoveryRun(prompt: HubRoleRecoveryPrompt, rollback: boolean, startedAt: number) {
  const targetHubId = rollback ? prompt.fromHubId : prompt.targetHubId;
  const operationId = randomOperationId();
  return {
    operationId,
    targetHubId,
    targetName: rollback ? prompt.fromName : prompt.targetName,
    persist: hubRoleSwitchPersist({
      operationId,
      targetHubId,
      fromHubId: null,
      intent: 'switch',
      startedAt,
    }),
  };
}

export function useHubRoleSwitch(
  deps: HubRoleSwitchDeps,
  onChanged: () => void,
  options: UseHubRoleSwitchOptions = {}
): HubRoleSwitchController {
  const { t } = useTranslation();
  const io = useMemo(() => options.io ?? createHubRoleIo(), [options.io]);
  const now = options.now ?? Date.now;

  const nameOf = useCallback(
    (nodeId: string) => deps.rows.find((row) => row.id === nodeId)?.name ?? nodeId.slice(0, 8),
    [deps.rows]
  );

  const latest = useRef<HubRoleLatest>({ io, nameOf, now, onChanged, t });
  latest.current = { io, nameOf, now, onChanged, t };

  const run = useHubRoleRun(latest);
  const { setPhase, drive } = run;
  const { force, setForce, forceResolve, resolveForce } = useHubRoleForce();
  const { plan, setPlan, request, dismiss } = useHubRolePlan(deps.hubs, deps.writerHubId, nameOf);

  const { api, mode, prompt } = deps;
  const confirm = useCallback(() => {
    if (!plan || !mode) {
      setPlan(null);
      return;
    }
    const { ids, targetName, operationId, persist } = hubRoleSwitchRun(plan, now());
    setPlan(null);
    toast.info(t('nodes.hubs.role.started'));
    drive(ids, targetName, ({ signal, onRecoverContext }) =>
      runHubRoleSwitch({
        plan,
        operationId,
        io,
        signal,
        phase: setPhase,
        persist,
        t,
        onRecoverContext,
        admit: (hub) =>
          admitHubSigned({ api, mode, prompt, io, target: hub, setForce, forceResolve }),
      })
    );
  }, [api, drive, forceResolve, io, mode, now, plan, prompt, setForce, setPhase, setPlan, t]);

  const recovery = run.recovery;
  const resolveRecovery = useCallback(
    (choice: HubRoleRecoveryChoice) => {
      const current = recovery;
      if (!current || choice === 'dismiss') {
        run.abandon();
        return;
      }
      const { targetHubId, targetName, operationId, persist } = hubRoleRecoveryRun(
        current,
        choice === 'rollback',
        now()
      );
      drive([current.targetHubId, current.fromHubId], targetName, ({ signal, onRecoverContext }) =>
        promoteHub({
          io,
          signal,
          phase: setPhase,
          persist,
          t,
          operationId,
          targetHubId,
          recover: { targetHubId: current.targetHubId, fromHubId: current.fromHubId },
          onRecoverContext,
        })
      );
    },
    [drive, io, now, recovery, run.abandon, setPhase, t]
  );

  const running = run.running;
  const stateOf = useCallback(
    (row: NodeRow, rowBusy: boolean) =>
      hubRoleButtonState({
        row,
        hubs: deps.hubs,
        writerHubId: deps.writerHubId,
        hubWritable: deps.hubWritable,
        switching: running,
        rowBusy,
        nameOf,
      }),
    [deps.hubWritable, deps.hubs, deps.writerHubId, nameOf, running]
  );

  const { phase, switchingIds } = run;
  return useMemo(
    () => ({
      switchingIds,
      running,
      plan,
      force,
      recovery,
      phase,
      request,
      confirm,
      dismiss,
      resolveForce,
      resolveRecovery,
      stateOf,
    }),
    [
      confirm,
      dismiss,
      force,
      phase,
      plan,
      recovery,
      request,
      resolveForce,
      resolveRecovery,
      running,
      stateOf,
      switchingIds,
    ]
  );
}

/**
 * 签一条 `admit-hub` 并提交。`head → 签名 → append` 整段进 key log 写锁：head 是全局的，
 * 与一条 admit-node 并行读到同一个头就会造出两条同 seq 的记录（见 `revokeNodeRecord`）。
 * 等用户勾「仍然继续」的对话框留在锁外，否则一发呆就把所有 admit 卡住。
 */
async function admitHubSigned(p: {
  api: AuthApi;
  mode: ResolvedMode;
  prompt: CredentialPromptHandle;
  io: HubRoleIo;
  target: HubRef;
  setForce: (prompt: HubRoleForcePrompt | null) => void;
  forceResolve: { current: ((accepted: boolean) => void) | null };
}): Promise<AdmitHubOutcome | { kind: 'cancelled' }> {
  const rootEpoch = requireRootEpoch(p.mode);
  const submit = async (signer: RecordSigner, force: boolean): Promise<AdmitHubOutcome> =>
    withKeyLogLock(async () => {
      const head: KeyLogHead = headFromResponse(await p.api.keyLogHead());
      const record = await buildAdmitHubRecord({
        head,
        rootEpoch,
        uid: p.mode.uid,
        hubNodeIdHex: p.target.nodeId,
        publicUrl: p.target.publicUrl,
        signer,
      });
      return p.io.appendAdmitHub(record, force);
    });

  const outcome = await p.prompt.withSigner(
    (signer) =>
      admitHubWithForce({
        submit: (force) => submit(signer, force),
        confirmForce: (info) =>
          new Promise<boolean>((resolve) => {
            p.forceResolve.current = resolve;
            p.setForce(info);
          }),
      }),
    { purpose: 'admit' }
  );
  return outcome ?? { kind: 'cancelled' };
}
