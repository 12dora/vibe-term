// 加入面板本次会话：创建时记下、admit 后打上标记、失效时清掉。
// 落 sessionStorage，刷新 / 重开面板后步骤 6 仍停在正确的状态。

import {
  type PendingEnrollment,
  listPendingEnrollments,
  subscribePendingEnrollments,
} from '@/node/enrollment';
import { type EnrollmentEngineState, admittedNodeIdFor } from '@/node/enrollment-engine';
import { migrateStorageKey } from '@vibeterm/stores';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

/**
 * 本次面板会话跟踪的那条 enrollment。**全是公开数据，绝不含加入码或私钥**。
 *
 * 落 sessionStorage：面板关掉再开、或整页刷新后，步骤 6 仍要停在正确的状态——
 * pending 本身活在 `enrollment.ts` 的 store 里，丢的只是「哪条是本次会话建的」这层关联，
 * 而「已加入」在 pending 被删之后只剩这个标记能证明（见 R4 #8）。
 *
 * 光存 id 不够：恢复回来的会话必须能证明自己讲的是**同一条 enrollment、同一套身份**，
 * 否则一个 id 相同的新 enrollment、甚至换了账号之后，都会认领这条陈旧的「已加入」
 * （见 R5「恢复的面板会话缺少绑定」）。因此还带 `enrollPk`/`createdAt`（对拍 pending）、
 * `uid`/`hubNodeId`（对拍当前身份）与 `admittedAt`（标记 24 小时后自然过期）。
 */
export interface JoinSession {
  id: string;
  /** base64url 的一次性注册公钥：pending 的唯一身份，公开数据。 */
  enrollPk: string;
  createdAt: number;
  exp: number;
  uid: string | null;
  hubNodeId: string | null;
  admitted: boolean;
  /** 打上「已加入」标记的时刻；未加入为 `null`。 */
  admittedAt: number | null;
  /** admit 那张证书里的新节点 id；重发路径拿不到证书，为 `null`。 */
  nodeId: string | null;
}

/** 「已加入」标记的最长寿命：过了就当作过期信息丢掉，别永远赖在步骤 6 上。 */
export const ADMITTED_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const SESSION_STORAGE_KEY = 'vibeterm.connectDevices.joinSession';
/** 改名前的键：升级后刷新页面仍要接上等待确认的加入流程 */
const LEGACY_SESSION_STORAGE_KEY = 'tmex.connectDevices.joinSession';

/** 当前这套身份：会话必须与它对得上才作数。 */
export interface JoinSessionIdentity {
  /** `/api/auth/mode` 已经拿到：还没拿到时**什么都不判**，否则刷新瞬间会把会话误清掉。 */
  ready: boolean;
  uid: string | null;
  hubNodeId: string | null;
  /** mesh 成员集里的 node id；`null` 表示列表还没加载出来，此时不做成员对账。 */
  nodeIds: string[] | null;
}

function sessionStore(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function parseJoinSession(parsed: unknown): JoinSession | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const row = parsed as Record<string, unknown>;
  const id = asNonEmptyString(row.id);
  const enrollPk = asNonEmptyString(row.enrollPk);
  if (!id || !enrollPk) return null;
  return {
    id,
    enrollPk,
    createdAt: numberOr(row.createdAt, 0),
    exp: numberOr(row.exp, 0),
    uid: typeof row.uid === 'string' ? row.uid : null,
    hubNodeId: typeof row.hubNodeId === 'string' ? row.hubNodeId : null,
    admitted: row.admitted === true,
    admittedAt: typeof row.admittedAt === 'number' ? row.admittedAt : null,
    nodeId: typeof row.nodeId === 'string' ? row.nodeId : null,
  };
}

export function readJoinSession(): JoinSession | null {
  try {
    const store = sessionStore();
    if (store) migrateStorageKey(store, LEGACY_SESSION_STORAGE_KEY, SESSION_STORAGE_KEY);
    const raw = store?.getItem(SESSION_STORAGE_KEY);
    return parseJoinSession(raw ? JSON.parse(raw) : null);
  } catch {
    return null;
  }
}

function writeJoinSession(session: JoinSession | null): JoinSession | null {
  try {
    const store = sessionStore();
    if (!store) return session;
    if (session) store.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    else store.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // 隐私模式下 sessionStorage 会抛；内存态仍然有效，刷新后丢失即可。
  }
  return session;
}

/** 「已加入」标记还算不算数：24 小时内，且（拿得到成员集时）那个节点还在 mesh 里。 */
function isAdmittedMarkerFresh(
  session: JoinSession,
  identity: JoinSessionIdentity,
  now: number
): boolean {
  if (session.admittedAt !== null && now - session.admittedAt > ADMITTED_SESSION_TTL_MS) {
    return false;
  }
  // 节点已被吊销 / 退出 mesh：步骤 6 不该继续说「已加入」。
  if (session.nodeId && identity.nodeIds) return identity.nodeIds.includes(session.nodeId);
  return true;
}

/**
 * 恢复出来的会话是否还该继续显示。
 *
 * 未加入的那条必须在权威 pending store 里找得到**同一条**（id + `enrollPk` + `createdAt`）；
 * 已加入的那条只剩标记可查，于是靠身份绑定 + 24 小时时效 + 成员集对账兜底。
 */
export function isSessionValid(
  session: JoinSession,
  input: {
    identity: JoinSessionIdentity;
    pendings: PendingEnrollment[];
    admittedByEngine: boolean;
    now: number;
  }
): boolean {
  if (session.uid !== input.identity.uid || session.hubNodeId !== input.identity.hubNodeId) {
    return false;
  }
  if (session.admitted || input.admittedByEngine) {
    return isAdmittedMarkerFresh(session, input.identity, input.now);
  }
  return input.pendings.some(
    (row) =>
      row.hubEnrollmentId === session.id &&
      row.enrollPk === session.enrollPk &&
      row.createdAt === session.createdAt
  );
}

function startSession(pending: PendingEnrollment, identity: JoinSessionIdentity): JoinSession {
  return {
    id: pending.hubEnrollmentId,
    enrollPk: pending.enrollPk,
    createdAt: pending.createdAt,
    exp: pending.exp,
    uid: identity.uid,
    hubNodeId: identity.hubNodeId,
    admitted: false,
    admittedAt: null,
    nodeId: null,
  };
}

/**
 * 跟踪本次面板会话那条 enrollment：创建时记下、admit 后打上标记、失效时清掉，
 * 整个过程同步落 sessionStorage，刷新 / 重开面板后步骤 6 仍停在正确的状态。
 */
export function useJoinSession(
  created: PendingEnrollment | null,
  engine: EnrollmentEngineState,
  identity: JoinSessionIdentity
): JoinSession | null {
  const pendings = useSyncExternalStore(
    subscribePendingEnrollments,
    listPendingEnrollments,
    listPendingEnrollments
  );
  const [session, setSession] = useState<JoinSession | null>(readJoinSession);
  // 每条新建的 enrollment 只开一次会话：身份刷新（成员集变化）不该把已经清掉的会话复活。
  const startedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!created || startedRef.current === created.hubEnrollmentId) return;
    startedRef.current = created.hubEnrollmentId;
    setSession(writeJoinSession(startSession(created, identity)));
  }, [created, identity]);

  const admittedByEngine = session !== null && engine.admittedIds.includes(session.id);
  const valid =
    identity.ready &&
    session !== null &&
    isSessionValid(session, { identity, pendings, admittedByEngine, now: Date.now() });
  useEffect(() => {
    if (!session || !identity.ready) return;
    if (!valid) {
      setSession(writeJoinSession(null));
      return;
    }
    if (admittedByEngine && !session.admitted) {
      setSession(
        writeJoinSession({
          ...session,
          admitted: true,
          admittedAt: Date.now(),
          nodeId: admittedNodeIdFor(session.id),
        })
      );
    }
  }, [session, valid, admittedByEngine, identity.ready]);

  return valid ? session : null;
}
