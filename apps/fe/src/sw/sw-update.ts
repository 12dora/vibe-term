// 换代接管：让页面真的用上服务端已经发布的那一代应用壳。
//
// sw.ts 刻意不做 skipWaiting / clients.claim——新 SW 装好自己那代缓存后要等旧客户端**全部**退出
// 才激活。桌面浏览器关个标签页就退出了，iOS 主屏 PWA 不会：切出去只是挂起，旧 SW 永远在控制，
// 加上导航是 600 ms 预算的网络优先（手机到公网 hub 的 RTT 300–800 ms，基本每次都超预算回放
// 上一代缓存壳），用户会无限期停在装机那天的 UI 上，服务端发多少版都看不见。
//
// 这里给出两条接管路径，都只在「安全时刻」动手，不打断正在敲命令的人：
//   1) 页面刚加载完就发现已经有 waiting：这一帧本来就什么都没做，直接握手 + 刷新；
//   2) 运行期装好新一代（updatefound → installed）或 SW 报「回放了旧壳」：记账，
//      等下一次**真正的回归**（在后台待够 30 s 后回到前台，或 bfcache 恢复）再握手 + 刷新。
//      切出去看一眼验证码再切回来不算回归——那种 5 秒的来回被整页刷新打断最气人。
//      不够格就继续排着队，下一个够格的时刻（或下一次页面加载）再应用。
// 另外每次回到前台顺手查一次更新（限流 60 s），否则挂起几天的 PWA 连「有新版」都不知道。
//
// 刷新循环的守卫：握手失败（waiting 那一版根本不认 skipWaiting，比如它比逃生通道还老）时，
// 刷多少次都是同一代。所以刷新前把时刻写进 sessionStorage，冷却期内不再刷；确认某次加载
// **没有 waiting**（上次接管真的生效了）就立刻清掉。用时刻而不是「本会话一次」：卡住的状态里
// 最多每个冷却期多刷一次，而真正的下一次发版也不会被上一次的失败永久挡住。

import { SW_SHELL_STALE_MESSAGE } from '@vibeterm/ui/sw-activation';

export { SW_SHELL_STALE_MESSAGE };

/** 回到前台时主动查更新的最小间隔：切来切去不该变成对网关的轮询 */
export const SW_UPDATE_CHECK_THROTTLE_MS = 60_000;

/** 在后台待够这么久，回到前台才算「真的离开过」，可以整页换代 */
export const SW_TAKEOVER_MIN_HIDDEN_MS = 30_000;

/** 上一次接管失败后的冷却：循环以秒计，真实发版以小时计，十分钟足够分开这两者 */
export const SW_TAKEOVER_COOLDOWN_MS = 600_000;

/** 值是上一次发起接管的时刻（毫秒） */
export const SW_UPDATE_GUARD_KEY = 'vibeterm.sw-update-reloaded';

export interface SwUpdateWorkerLike {
  readonly state: string;
  addEventListener(type: 'statechange', listener: () => void): void;
  removeEventListener(type: 'statechange', listener: () => void): void;
}

export interface SwUpdateRegistrationLike {
  readonly waiting: unknown;
  readonly installing: SwUpdateWorkerLike | null;
  update(): Promise<unknown>;
  addEventListener(type: 'updatefound', listener: () => void): void;
}

export interface SwUpdateDeps {
  registration: SwUpdateRegistrationLike;
  /** 已经被某一代 SW 控制：没有 controller 说明是首次安装，装好即当代，没有「换代」可言 */
  hasController: () => boolean;
  /** 给 waiting 的 SW 发 skipWaiting 并等 controllerchange（@vibeterm/ui 的 activateWaitingWorker） */
  activate: () => Promise<void>;
  reload: () => void;
  now: () => number;
  readGuard: () => string | null;
  /** `null` 表示清除 */
  writeGuard: (value: string | null) => void;
}

export interface SwUpdateController {
  /** 页面加载时调用一次：已有 waiting 就立刻接管，没有就清掉刷新守卫。返回是否发起了刷新。 */
  start(): Promise<boolean>;
  /** SW 报「本次导航回放的是旧壳」：手上已有 waiting 才排队，否则等 updatefound */
  onShellStale(): void;
  /** 页面转入后台：记下时刻，回来时据此判断这次算不算「真的离开过」 */
  onHidden(): void;
  /**
   * 回到前台 / pageshow：排着队的换代**在后台待够 30 s** 才接管，否则继续排队；
   * 没有待接管的换代就限流查一次更新。`persisted` 是 bfcache 恢复，一律算回归。
   */
  onSafeMoment(options?: { persisted?: boolean }): Promise<boolean>;
  /** 已排队等待安全时刻接管（测试与调试用） */
  readonly pending: boolean;
}

export function createSwUpdateController(deps: SwUpdateDeps): SwUpdateController {
  let pending = false;
  let hiddenAt: number | null = null;
  // 首次回到前台必须查一次：起点取负无穷，而不是 0（时间戳本身就可能小于限流窗口）
  let lastCheckAt = Number.NEGATIVE_INFINITY;

  const takeover = async (): Promise<boolean> => {
    const now = deps.now();
    const last = Number.parseInt(deps.readGuard() ?? '', 10);
    // 存的时刻晚于现在只可能是用户改了系统时钟，按「没有守卫」处理
    if (Number.isFinite(last) && now >= last && now - last < SW_TAKEOVER_COOLDOWN_MS) return false;
    deps.writeGuard(String(now));
    pending = false;
    await deps.activate().catch(() => undefined);
    deps.reload();
    return true;
  };

  // installing 的 worker 走到 installed 才算「新一代就位」；redundant（装失败）什么都不做
  const watchInstalling = (): void => {
    const worker = deps.registration.installing;
    if (!worker) return;
    const onState = () => {
      if (worker.state === 'installing') return;
      worker.removeEventListener('statechange', onState);
      if (worker.state === 'installed' && deps.hasController()) pending = true;
    };
    worker.addEventListener('statechange', onState);
  };

  return {
    get pending() {
      return pending;
    },
    async start() {
      deps.registration.addEventListener('updatefound', watchInstalling);
      // 没有 controller 就没有「旧代」可换：这一页本来就是直接吃服务端的新壳，
      // 此时哪怕 waiting 里躺着一版（首次安装、SW 被杀后重装）也不值得刷一次
      if (!deps.registration.waiting || !deps.hasController()) {
        deps.writeGuard(null);
        return false;
      }
      return takeover();
    },
    onShellStale() {
      if (deps.registration.waiting) pending = true;
    },
    onHidden() {
      hiddenAt = deps.now();
    },
    async onSafeMoment(options = {}) {
      const now = deps.now();
      const hiddenFor = hiddenAt === null ? null : now - hiddenAt;
      hiddenAt = null;
      if (pending || deps.registration.waiting) {
        // 留着队不清：这次不够格，下一个够格的时刻（或下次加载）照样接管
        pending = true;
        const resumed =
          options.persisted === true ||
          (hiddenFor !== null && hiddenFor >= SW_TAKEOVER_MIN_HIDDEN_MS);
        return resumed ? takeover() : false;
      }
      if (now - lastCheckAt < SW_UPDATE_CHECK_THROTTLE_MS) return false;
      lastCheckAt = now;
      await deps.registration.update().catch(() => undefined);
      return false;
    },
  };
}

export function browserSwUpdateGuard(): Pick<SwUpdateDeps, 'readGuard' | 'writeGuard'> {
  return {
    readGuard: () => {
      try {
        return globalThis.sessionStorage?.getItem(SW_UPDATE_GUARD_KEY) ?? null;
      } catch {
        return null;
      }
    },
    writeGuard: (value) => {
      try {
        if (value === null) globalThis.sessionStorage?.removeItem(SW_UPDATE_GUARD_KEY);
        else globalThis.sessionStorage?.setItem(SW_UPDATE_GUARD_KEY, value);
      } catch {
        // 隐私模式下 sessionStorage 不可用：最坏是多刷一次页，好过一直停在旧壳
      }
    },
  };
}

/** SW 发来的消息是不是「刚才回放了上一代壳」 */
export function isShellStaleMessage(data: unknown): boolean {
  return (data as { type?: unknown } | null)?.type === SW_SHELL_STALE_MESSAGE;
}
