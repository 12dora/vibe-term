// 宿主级的 node 运行时管理器与每 node 的 QueryClient。
//
// - 运行时（连接 / ApiClient / store）由 NodeConnectionManager 按 nodeId 懒建并引用计数。
// - React Query 缓存按 node 隔离：不是给每个 query key 加 nodeId 前缀（那要求改动所有
//   包内调用点，且会破坏包内既有的 `invalidateQueries(['files'])` 这类跨 key 失效），
//   而是每个 node 一个 QueryClient——隔离更彻底，且 key 语义完全不变。
// - 非 self 的 node 在建连时同时起一个 `DirectCarrierController`（F3-1）：信令走
//   `/mesh/ws` 的 `RTC_SIGNAL`，诊断挂到 `connection.directDiagnostics` 供设备页徽标读取，
//   并把 `BulkClient`（F3-2 的文件直传）按 nodeId 登记给文件面板。控制器拿本连接当前 socket
//   的 client nonce（WS URL 上的 `?cid=`）去换服务端 `connectionId`（F3-5）。
//   `self` 是浏览器直接连的 entry，没有第二跳，永远不建直连。
// - 直连栈（`@vibeterm/ws-client/direct`，约 19 KB gz）**按需加载**：只有真的要给远端 node
//   升级链路时才 `import()`。加载失败不影响 WS（只记一条日志），下一次建连再试；加载
//   期间连接被 dispose 就直接放弃，不留悬挂的控制器。诊断源在建连的同一帧同步挂上一个
//   占位实现（`createDeferredDiagnosticsSource`），控制器就位后转发，UI 不会错过订阅。
// - 直连断开回落 primary 时，`setResumeSubscribedPanes` 钩子在这里接上该 node 的 pane
//   订阅面：重发订阅 + 对挂载中的 pane 重新拉一次画面，并提示用户最近输入可能未送达。

import { sonnerNotificationSink } from '@/lib/sonner-notification-sink';
import { deviceSnapshotPlaceholder } from '@/pages/devices/device-snapshot-store';
import { QueryClient } from '@tanstack/react-query';
import {
  type DevicesResponse,
  createNodeApiClient,
  createNodeWsUrlSource,
  devicesQueryKey,
  isSelfNode,
  nodeWsUrl,
} from '@vibeterm/api-client';
import type { NotificationSink } from '@vibeterm/notifications';
import {
  type AppRuntime,
  NodeConnectionManager,
  type NodeConnectionManagerOptions,
  normalizeNodeId,
} from '@vibeterm/stores';
import type { NodeReloginResult } from '@vibeterm/stores/node-session-guard';
import {
  type GatewayConnection,
  type SocketFactory,
  createGatewayConnection,
} from '@vibeterm/ws-client';
import type {
  DirectCarrierController,
  DirectSignalMessage,
  DirectSignalingTransport,
} from '@vibeterm/ws-client/direct';
import { createDeferredDiagnosticsSource } from '@vibeterm/ws-client/direct/types';
import i18n from 'i18next';
import {
  type DirectLinkClientLike,
  isDirectLinkUnavailable,
  watchDirectNegotiation,
} from './direct-link-availability';
import { type MeshEventSource, sharedMeshEvents } from './mesh-events';
import { getMeshNodesState, markLoggedOut, subscribeMeshNodes } from './mesh-nodes';
import { onPageRecovery } from './mesh-recovery';
import { resolveMeshNodeName } from './node-names';
import { createGatedNodeApiClient, probeNodeSession } from './node-session-probe';
import { type NodeSessionRecoveryOutcome, recoverNodeSession } from './node-session-recovery';
import { clearNodeBackoff, nodeBackoffRemainingMs } from './node-unreachable-backoff';

/** 当前入口自身的 nodeId（`/api/auth/mode` 还没落地时为 null）。 */
function entryNodeIdNow(): string | null {
  return getMeshNodesState().entryNodeId;
}

/**
 * `/mesh/ws` 的 `RTC_SIGNAL` 只有**一个** handler 槽（见 `mesh-events.ts` 的注释），
 * 而每个非 self 的 node 各有一个控制器，所以这里做一层扇出：信令按 `rtcSession` 由
 * 各控制器自行过滤，扇出不会让某个控制器抢答别人的 answer。
 *
 * `send` 如实返回 `sendRtcSignal` 的结果，并透出 `isReady` / `onReady`：`/mesh/ws` 正在
 * 退避重连时控制器不会白开 attempt，信令排队；连上后立刻重置直连退避重试一次。
 */
class MeshRtcSignalHub {
  private readonly handlers = new Set<(signal: DirectSignalMessage) => void>();
  private bound: MeshEventSource | null = null;

  constructor(private readonly resolveSource: () => MeshEventSource) {}

  transport(): DirectSignalingTransport {
    return {
      send: (signal) => this.source().sendRtcSignal(signal),
      onSignal: (cb) => {
        this.handlers.add(cb);
        this.bind();
        return () => {
          this.handlers.delete(cb);
        };
      },
      isReady: () => this.resolveSource().connected,
      onReady: (cb) => {
        const source = this.source();
        return source.onStatusChange(() => cb(source.connected));
      },
    };
  }

  private source(): MeshEventSource {
    const source = this.resolveSource();
    source.start();
    return source;
  }

  private bind(): void {
    const source = this.source();
    if (this.bound === source) return;
    this.bound = source;
    source.setRtcSignalHandler((signal) => {
      for (const handler of [...this.handlers]) handler(signal);
    });
  }
}

const meshRtcSignals = new MeshRtcSignalHub(() => sharedMeshEvents());

/** 懒加载的直连栈里，宿主真正要用到的三个符号。 */
export type DirectLinkModule = Pick<
  typeof import('@vibeterm/ws-client/direct'),
  'BulkClient' | 'DirectCarrierController' | 'registerBulkClient'
>;

let directModule: Promise<DirectLinkModule | null> | null = null;
let directLoadLogged = false;

/**
 * 按需拉直连栈。失败（发版后旧 index.html 指向的 chunk 404）只记一条日志并回 `null`——
 * 连接留在 WS 上照常可用，缓存的 promise 一并清掉，下一次建连会重新试。
 */
function loadDirectModule(): Promise<DirectLinkModule | null> {
  if (directModule) return directModule;
  const pending: Promise<DirectLinkModule | null> = import('@vibeterm/ws-client/direct').catch(
    (error: unknown) => {
      if (directModule === pending) directModule = null;
      if (!directLoadLogged) {
        directLoadLogged = true;
        console.warn('[direct] 直连栈加载失败，继续走 WS', error);
      }
      return null;
    }
  );
  directModule = pending;
  return pending;
}

export interface NodeDirectWiring {
  /** 自建连接（测试注入）。**必须**把第二个参数接到真 socket 的 `onclose` 上。 */
  createConnection?: (nodeId: string, onClose: (code: number) => void) => GatewayConnection;
  /** 直连栈加载器（测试注入）；缺省按需 `import('@vibeterm/ws-client/direct')`。 */
  loadDirect?: () => Promise<DirectLinkModule | null>;
  createController?: (
    nodeId: string,
    connection: GatewayConnection,
    /** 本连接当前 socket 的 client nonce（`?cid=`）；还没建过 socket 时为 null。 */
    cid: () => string | null
  ) => DirectCarrierController | null;
  /** WS 关闭码回调（宿主用它识别 4401）。 */
  onClose?: (code: number) => void;
  /** 覆盖底层 socket 工厂（测试注入）：其余接线保持生产路径不变。 */
  socketFactory?: SocketFactory;
  /** 取该 node 的运行时（测试注入）；缺省从 `appNodeRuntimes` 取已建好的那份。 */
  resolveRuntime?: (nodeId: string) => AppRuntime | null;
  /** 直连断开提示的出口（测试注入）；缺省用 runtime 自己的 sink。 */
  notifications?: NotificationSink;
}

function defaultController(
  direct: DirectLinkModule,
  nodeId: string,
  connection: GatewayConnection,
  cid: () => string | null,
  apiClient: DirectLinkClientLike
): DirectCarrierController {
  return new direct.DirectCarrierController({
    nodeId,
    apiClient,
    signaling: meshRtcSignals.transport(),
    connection,
    cid,
  });
}

/**
 * 取该 node 已建好的运行时。**不能触发懒建**：本函数会在 `createNodeConnection` 的
 * 回调里被调用，而 `createNodeConnection` 本身正是 manager 建 runtime 的一环，
 * 递归进去会栈溢出。runtime 还没建好时（直连不可能先于它断开）直接放弃这次补齐。
 */
function resolveExistingRuntime(nodeId: string): AppRuntime | null {
  return appNodeRuntimes.has(nodeId) ? appNodeRuntimes.get(nodeId).runtime : null;
}

/** 该 device 下当前**挂载着终端实例**的 pane（注册表里有 sink 即挂载中）。 */
function mountedPaneIds(
  connection: GatewayConnection,
  runtime: AppRuntime,
  deviceId: string
): string[] {
  const tmux = runtime.stores.tmux.getState();
  const ids = new Set<string>();
  for (const window of tmux.snapshots[deviceId]?.session?.windows ?? []) {
    for (const pane of window.panes) {
      if (connection.paneSinks.hasPaneSink(deviceId, pane.id)) ids.add(pane.id);
    }
  }
  const selected = tmux.selectedPanes[deviceId];
  if (selected && connection.paneSinks.hasPaneSink(deviceId, selected.paneId)) {
    ids.add(selected.paneId);
  }
  return [...ids];
}

/** 直连断开提示的文案 key（locale 里有正式条目，不再靠 `defaultValue` 兜底）。 */
const DIRECT_FALLBACK_KEY = 'device.directFallbackToast';

/** runtime 还没建好时它自己的 `t` 也没有，退到宿主的全局 i18n 实例。 */
function directFallbackText(runtime: AppRuntime | null): string {
  return runtime?.t(DIRECT_FALLBACK_KEY) || i18n.t(DIRECT_FALLBACK_KEY) || DIRECT_FALLBACK_KEY;
}

/**
 * 切回 primary（含直连异常关闭）后的补齐：
 * 1. 重发该 device 的整份 pane 订阅——`mountPane()` 拿到的释放函数**立刻调用**，
 *    引用计数一加一减回到原值，但两次都会以新 generation 重下发当前订阅集合；
 *    订阅面在 `@vibeterm/stores`，没有对外暴露「只重发一次」的入口（见 result 备注）。
 * 2. 提示用户：浏览器→node 方向的最近输入可能没送到（这一方向没有补齐机制）。
 *
 * canonical feed 由带 cursor 的重订阅精确补流，只有服务端明确返回 gap 时才重取整屏，
 * 因此这里不主动请求首屏。
 */
function resumeSubscribedPanes(
  nodeId: string,
  connection: GatewayConnection,
  wiring: NodeDirectWiring
): void {
  const runtime = (wiring.resolveRuntime ?? resolveExistingRuntime)(nodeId);
  const sink = wiring.notifications ?? runtime?.notifications ?? sonnerNotificationSink;
  if (runtime) {
    const tmux = runtime.stores.tmux.getState();
    for (const deviceId of tmux.connectedDevices) {
      const first = mountedPaneIds(connection, runtime, deviceId)[0];
      if (first === undefined) continue;
      tmux.mountPane(deviceId, first)();
    }
  }
  sink.warning(directFallbackText(runtime));
}

const directLinkPending = new WeakMap<GatewayConnection, Promise<void>>();

/** 等这条连接的直连接线落定（加载失败、控制器为 null、建连途中被 dispose 都算落定）。 */
export function directLinkSettled(connection: GatewayConnection): Promise<void> {
  return directLinkPending.get(connection) ?? Promise.resolve();
}

/**
 * 给一条已建好的远端 node 连接接上直连：诊断占位源与 resume 钩子同步挂好（UI 在同一帧就会
 * 订阅），控制器等直连栈 chunk 到位后再建。dispose 与加载是并发的，靠 `disposed` 标志裁决：
 * 先 dispose 的话加载完成后什么都不做，不会留下没人 stop 的 `RTCPeerConnection`。
 */
function attachDirectLink(
  nodeId: string,
  connection: GatewayConnection,
  cid: () => string | null,
  wiring: NodeDirectWiring
): void {
  const diagnostics = createDeferredDiagnosticsSource();
  connection.directDiagnostics = diagnostics;
  connection.setResumeSubscribedPanes(() => resumeSubscribedPanes(nodeId, connection, wiring));

  let disposed = false;
  let controller: DirectCarrierController | null = null;
  let direct: DirectLinkModule | null = null;
  /** 停掉这次直连（协商被入口代答、或连接被回收）：控制器、bulk 通道、诊断源一并摘掉。 */
  const stopDirect = () => {
    if (!controller) return;
    direct?.registerBulkClient(nodeId, null);
    controller.stop();
    controller = null;
    diagnostics.attach(null);
  };
  const baseDispose = connection.dispose.bind(connection);
  connection.dispose = () => {
    disposed = true;
    connection.setResumeSubscribedPanes(null);
    stopDirect();
    diagnostics.attach(null);
    baseDispose();
  };

  const pending = (wiring.loadDirect ?? loadDirectModule)().then((loaded) => {
    if (!loaded || disposed) return;
    // 这条入口最近已经答过「给不出直连」：30 分钟内不再白协商一次（见 direct-link-availability）。
    if (isDirectLinkUnavailable(nodeId, entryNodeIdNow())) return;
    const created = wiring.createController
      ? wiring.createController(nodeId, connection, cid)
      : defaultController(
          loaded,
          nodeId,
          connection,
          cid,
          watchDirectNegotiation(nodeId, createNodeApiClient(nodeId), stopDirect, entryNodeIdNow)
        );
    if (!created) return;
    direct = loaded;
    controller = created;
    diagnostics.attach(created.diagnosticsSource);
    // 文件面板只拿得到 nodeId，bulk 通道按 nodeId 登记（F3-2）。
    loaded.registerBulkClient(nodeId, new loaded.BulkClient(created));
    created.start();
  });
  directLinkPending.set(connection, pending);
}

/**
 * 建一个 node 的 `GatewayConnection`，非 self 的顺带起直连控制器。
 * 控制器随连接 `dispose()` 一并停掉（否则 30 s 宽限期回收后 RTCPeerConnection 会漏）。
 */
export function createNodeConnection(
  nodeId: string,
  wiring: NodeDirectWiring = {}
): GatewayConnection {
  // 关闭码回调对两条工厂路径都是**必给**的：自建工厂不接它，4401 就没人处理，
  // ws-client 会一路重连到被反复关掉（见 F4-fix 评审 Major）。
  const onClose = wiring.onClose ?? (() => undefined);
  // 每建一条 socket（含重连）换一个 client nonce：node 只能靠握手 URL 上的 `?cid=` 把这条
  // Gateway WS 认出来，直连控制器随后用它换回服务端生成的 `connectionId`。
  const wsUrls = createNodeWsUrlSource(nodeId);
  const connection = (
    wiring.createConnection ??
    ((id, close) =>
      createGatewayConnection({
        wsUrl: nodeWsUrl(id),
        wsUrlFactory: () => wsUrls.nextUrl(),
        onClose: close,
        ...(wiring.socketFactory ? { socketFactory: wiring.socketFactory } : {}),
      }))
  )(nodeId, onClose);
  if (isSelfNode(nodeId)) return connection;

  attachDirectLink(nodeId, connection, () => wsUrls.cid(), wiring);
  return connection;
}

/**
 * 静默重登的结局翻译。`skipped` 是「这一轮已经重登过一次」——会话理应还在，
 * 调用方该继续重连而不是当场判定「需要登录」；`ignored`（self / 不该管的错误）按失败处理。
 */
function toReloginResult(outcome: NodeSessionRecoveryOutcome): NodeReloginResult {
  if (outcome === 'recovered') return 'recovered';
  return outcome === 'skipped' ? 'skipped' : 'failed';
}

/**
 * 宿主的 manager 接线。**生产与测试走同一份**：4401 的关闭码从真 socket → `createNodeConnection`
 * → manager 这条链上任何一环断了，测试就会红（不允许再用手动 `notifyClose()` 假装接通）。
 *
 * `wiring` 只用来注入底层 socket 工厂之类的测试替身，接线本身不可覆盖。
 */
export function createAppNodeRuntimes(
  overrides: NodeConnectionManagerOptions = {},
  wiring: Pick<NodeDirectWiring, 'socketFactory' | 'createController' | 'loadDirect'> = {}
): NodeConnectionManager {
  return new NodeConnectionManager({
    // 宿主只有一个 toaster，全部 node 共用同一个通知出口（不再经全局可变默认 sink）。
    notifications: sonnerNotificationSink,
    // 包内提示语只有 nodeId，点名哪台机器要查宿主的节点目录；每次调用现查 store，
    // 建 runtime 那一刻列表可能还没拉到。
    runtimeOptions: (nodeId) => ({
      resolveNodeName: resolveMeshNodeName,
      // 包内的重试按钮按下时调它：用户明确要现在再试一次，退避门必须让路。
      releaseRequestBackoff: () => clearNodeBackoff(nodeId),
    }),
    // manager 把关闭码回调递进来，直接转给底层连接：4401 由 manager 统一处理。
    createConnection: (nodeId, onClose) => createNodeConnection(nodeId, { ...wiring, onClose }),
    // 每 node 的 REST 都走带退避门的客户端：设备列表在包内有多个观察者，
    // react-query 的 `enabled` 拦不住它们，只有客户端这一层收得住。
    createApiClient: (nodeId) => createGatedNodeApiClient(nodeId),
    // 4401 之后的会话探测：退避窗口里不发、自带 8 秒超时、成败回喂退避记账。
    probeNodeSession,
    // 探测确认「这台 node 真的要重新登录」之后，用会话钥静默重登一次；
    // 与设备列表 401 的自愈共用同一份记账，一轮失效不会重登两次。
    // 三种结局如实传出去：`skipped`（这一轮已经登过）不等于失败，判成失败会让一次 4401
    // 就走到「需要登录」的终局。
    reloginNode: (nodeId) => recoverNodeSession(nodeId).then(toReloginResult),
    // 判定终局时把该 node 标未登录：界面这才会出现「登录此节点」按钮。
    markNodeLoggedOut: (nodeId) => void markLoggedOut(nodeId),
    // 打不通的 node 正在退避里：4401 的重连不早于退避窗口结束，别去撞注定不通的链路。
    reconnectDelayFloorMs: nodeBackoffRemainingMs,
    // 引用计数归零、runtime 真正回收时一并释放该 node 的查询缓存。
    onDispose: (nodeId) => disposeNodeQueryClient(nodeId),
    ...overrides,
  });
}

export const appNodeRuntimes: NodeConnectionManager = createAppNodeRuntimes();

/**
 * `['devices']` 的过期时间。设备列表**没有推送通道**：DEVICE_EVENT 说的是某台设备的连接
 * 状态，增删改只有本页的乐观更新会就地改缓存，别处（另一个浏览器、node 上的 CLI）的变更
 * 只能靠回源。5 秒意味着每次切回前台都要给每个挂载中的 node 各发一条 `/api/devices`——
 * PWA 恢复时最贵的一串请求就是它。
 *
 * 拉到 60 秒。`refetchOnWindowFocus` 保持开启：它只补拉**已过期**的查询，所以一分钟内的
 * 来回切换不再回源，超过一分钟的恢复照旧立刻拿到新列表——「页面恢复时补一次」这件事
 * 由它天然覆盖，不需要再往 `onPageRecovery` 上挂一条重复的失效。
 */
export const DEVICES_STALE_MS = 60_000;

function createNodeQueryClient(nodeId: string): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5000,
        retry: 1,
      },
    },
  });
  // 首帧占位挂在**客户端缺省**上而不是各调用点：设备页的卡片网格、控制台的当前设备、
  // 侧边栏都是同一个 key 的观察者，挂在这里它们一次都不用改就都拿到冷启动首帧。
  // 显式传了 `placeholderData` 的调用点（侧边栏自带快照 + inventory 兜底）照常覆盖它。
  client.setQueryDefaults<DevicesResponse>(devicesQueryKey, {
    staleTime: DEVICES_STALE_MS,
    placeholderData: () => deviceSnapshotPlaceholder(nodeId),
  });
  return client;
}

const queryClients = new Map<string, QueryClient>();

/** 取该 node 的 QueryClient（懒建）。 */
export function nodeQueryClient(nodeId: string | undefined): QueryClient {
  const id = normalizeNodeId(nodeId);
  let client = queryClients.get(id);
  if (!client) {
    client = createNodeQueryClient(id);
    queryClients.set(id, client);
  }
  return client;
}

/** 释放该 node 的查询缓存（运行时被回收时调用）。 */
export function disposeNodeQueryClient(nodeId: string | undefined): void {
  const id = normalizeNodeId(nodeId);
  const client = queryClients.get(id);
  if (!client) return;
  queryClients.delete(id);
  client.clear();
}

// 页面重新可见 / 网络恢复：把 4401 恢复里待发的重连提到现在（判定过终局的那些也再试一次）。
onPageRecovery(() => appNodeRuntimes.resumeSessionRecovery());

/**
 * 有 node 从「未登录」翻成「已登录」：用户点了「登录此节点」，或门闸的静默登录成功了。
 * 4401 判定终局时停掉的那条连接这时候就该拉起来，不必干等下一个 10 分钟的慢速拍。
 */
export function hasLoginRecovery(
  previous: ReadonlyMap<string, boolean>,
  next: readonly { id: string; loggedIn?: boolean }[]
): boolean {
  return next.some((node) => previous.get(node.id) === false && node.loggedIn === true);
}

function watchLoginRecovery(): void {
  let seen = new Map<string, boolean>();
  subscribeMeshNodes(() => {
    const { nodes } = getMeshNodesState();
    const recovered = hasLoginRecovery(seen, nodes);
    seen = new Map(nodes.map((node) => [node.id, node.loggedIn === true]));
    if (recovered) appNodeRuntimes.resumeSessionRecovery();
  });
}

watchLoginRecovery();
