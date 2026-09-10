// 应用壳 Service Worker：iOS 主屏 PWA 每次回到前台都是冷启动，壳与资源全部走网络
// （index.html 是 no-cache，字体 2.48 MB 每次至少一次条件请求），这里把「一代构建」的
// index.html + 全部哈希资源 + 三个默认字体整体缓存下来，冷启动只剩 API 往返。
//
// 生成策略：缓存名带构建 id（版本 + 预缓存清单哈希），一次构建一代。默认不做
// skipWaiting / clients.claim——新 SW 装好自己那代缓存后等旧客户端全部退出才激活，
// 正在跑的页面始终拿到同一代的壳与 chunk，杜绝「壳更新了但 chunk 哈希已不存在」的整页刷新。
//
// 「等旧客户端退出」本身需要逃生通道，否则节点升级换掉 fe-dist 之后会卡死在旧代：
//   1) 页面发现 chunk 404 时给 waiting 的 SW 发 vibeterm:sw-skip-waiting，让它立刻接管；
//   2) SW 自己发现某个 /assets/** 在服务端已 404，就地拆掉本代缓存并注销自己；
//   3) 本代预缓存有缺口时（lazy/字体是尽力而为），导航一律网络优先，缓存只作离线兜底。
//
// 路由分类见 ./sw-routes（纯函数，单测覆盖）。分类为 bypass 的请求连 respondWith 都不调，
// 由浏览器原样发出。

import { SW_SKIP_WAITING_MESSAGE } from './sw-messages';
import { SHELL_URL, type SwRouteKind, classifyRequest } from './sw-routes';

// 由 vite 插件在打包 sw.js 时 define 注入
declare const __SW_BUILD_ID__: string;
declare const __SW_PRECACHE__: {
  /** 首屏必备：index.html 与它直接引用的入口 js/css + modulepreload 依赖 */
  core: readonly string[];
  /** 其余哈希 chunk（懒路由、面板、wasm）：装不上只是回落到按需下载 */
  lazy: readonly string[];
  /** index.css 静态声明的默认等宽字体（约 2.48 MB） */
  fonts: readonly string[];
};

interface SwExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface SwFetchEvent extends SwExtendableEvent {
  readonly request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

interface SwMessageEvent extends SwExtendableEvent {
  readonly data: unknown;
}

interface SwGlobalScope {
  readonly location: { origin: string };
  readonly registration: { update(): Promise<void>; unregister(): Promise<boolean> };
  skipWaiting(): Promise<void>;
  addEventListener(
    type: 'install' | 'activate',
    listener: (event: SwExtendableEvent) => void
  ): void;
  addEventListener(type: 'fetch', listener: (event: SwFetchEvent) => void): void;
  addEventListener(type: 'message', listener: (event: SwMessageEvent) => void): void;
}

declare const self: SwGlobalScope;

const CACHE_PREFIX = 'vibeterm-shell-';
const CACHE_NAME = `${CACHE_PREFIX}${__SW_BUILD_ID__}`;

/**
 * 导航请求让给网络的时间预算。服务端自己的导航门（Cloudflare Access 302、
 * guardEntryAccess 403、域名访问 403 文本页）必须有机会接管，否则缓存壳会把它们全遮住；
 * 超时或离线才回放缓存壳——本机/内网几十毫秒就回来了，冷启动收益基本不受影响。
 */
const SHELL_NETWORK_BUDGET_MS = 600;

/** 尽力而为的预缓存并发上限：一次性发出两百多个请求会和首屏自己的数据请求抢连接 */
const OPTIONAL_PRECACHE_CONCURRENCY = 6;

/** 本代预缓存是否有缺口的标记。只能存缓存里：SW 随时会被杀，模块变量活不过一次休眠。 */
const PARTIAL_MARKER_URL = '/__vibeterm-sw__/partial-generation';

/** respondWith 的 promise 落定后再调 waitUntil 会抛 InvalidStateError，这里统一吞掉 */
function keepAlive(event: SwExtendableEvent, promise: Promise<unknown>): void {
  try {
    event.waitUntil(promise.catch(() => undefined));
  } catch {
    void promise.catch(() => undefined);
  }
}

/** 返回失败条数，调用方据此判断本代是否完整 */
async function addBestEffort(cache: Cache, urls: readonly string[]): Promise<number> {
  const queue = [...urls];
  const lanes = Math.min(OPTIONAL_PRECACHE_CONCURRENCY, queue.length);
  let failed = 0;
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
        await cache.add(url).catch(() => {
          failed += 1;
        });
      }
    })
  );
  return failed;
}

let partialGeneration: Promise<boolean> | null = null;

function isPartialGeneration(cache: Cache): Promise<boolean> {
  partialGeneration ??= cache.match(PARTIAL_MARKER_URL).then(
    (hit) => Boolean(hit),
    () => false
  );
  return partialGeneration;
}

async function markPartialGeneration(cache: Cache): Promise<void> {
  partialGeneration = Promise.resolve(true);
  await cache.put(PARTIAL_MARKER_URL, new Response('1'));
}

/**
 * 安装期顺手清理：被顶掉的安装（装完还没激活就来了新版本）会各留一代约 10 MB 缓存，
 * 只在 activate 里清等于永远清不到。caches.keys() 按创建顺序返回，最后一代视为当前活动代，
 * 保留它与本代，更早的一律删掉。
 */
async function pruneDiscardedGenerations(): Promise<void> {
  const others = (await caches.keys()).filter(
    (name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME
  );
  await Promise.all(others.slice(0, -1).map((name) => caches.delete(name)));
}

async function precacheGeneration(): Promise<void> {
  const cache = await caches.open(CACHE_NAME);
  // 首屏那一批缺一不可：任一失败即放弃本代安装，宁可继续用旧代也不留半套壳
  await cache.addAll([...__SW_PRECACHE__.core]);
  // 懒 chunk 与字体是渐进增强，逐个补、失败只回落到按需下载
  const failed = await addBestEffort(cache, [...__SW_PRECACHE__.lazy, ...__SW_PRECACHE__.fonts]);
  if (failed > 0) await markPartialGeneration(cache);
  await pruneDiscardedGenerations();
}

async function dropOtherGenerations(): Promise<void> {
  const names = await caches.keys();
  const stale = names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME);
  await Promise.all(stale.map((name) => caches.delete(name)));
}

/**
 * 本代缓存指着的 chunk 在服务端已经不存在（节点升级换了 fe-dist）：这一代整体作废，
 * 拆掉缓存并注销自己，下一次导航直接吃服务端的新壳，由它再装一代新的。
 */
async function selfDestruct(): Promise<void> {
  await caches.delete(CACHE_NAME);
  await self.registration.unregister();
}

async function cacheFirst(event: SwFetchEvent, kind: SwRouteKind): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(event.request);
  if (hit) return hit;
  const response = await fetch(event.request);
  if (kind === 'asset' && response.status === 404) {
    keepAlive(event, selfDestruct());
    return response;
  }
  if (response.status === 200 && response.type === 'basic') {
    keepAlive(event, cache.put(event.request, response.clone()));
  }
  return response;
}

/** 网络优先但带预算：任何状态码（含 302 的 opaqueredirect）都算网络接管；超时/失败返回 null */
function raceShellNetwork(request: Request, budgetMs: number): Promise<Response | null> {
  return new Promise((resolve) => {
    const timer = Number.isFinite(budgetMs) ? setTimeout(() => resolve(null), budgetMs) : undefined;
    const settle = (response: Response | null) => {
      if (timer !== undefined) clearTimeout(timer);
      resolve(response);
    };
    fetch(request).then(settle, () => settle(null));
  });
}

/**
 * 导航：先给服务端一个短预算接管（访问门、302），超时才回放本代缓存的壳，同时触发一次
 * SW 更新检查。**不**把新 index.html 写回本代缓存——新壳配旧 chunk 哈希正是要避免的组合，
 * 换代由新 SW 装好新一代缓存后完成。
 */
async function shellFirst(event: SwFetchEvent): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(SHELL_URL);
  if (!cached) return fetch(event.request);
  const budget = (await isPartialGeneration(cache))
    ? Number.POSITIVE_INFINITY
    : SHELL_NETWORK_BUDGET_MS;
  const network = await raceShellNetwork(event.request, budget);
  if (network) return network;
  keepAlive(event, self.registration.update());
  return cached;
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheGeneration());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(dropOtherGenerations());
});

// 页面侧逃生通道：chunk 404 时让 waiting 的这一版立刻接管，再刷新（见 ./sw-reload.ts）
self.addEventListener('message', (event) => {
  if ((event.data as { type?: unknown } | null)?.type !== SW_SKIP_WAITING_MESSAGE) return;
  keepAlive(event, self.skipWaiting());
});

self.addEventListener('fetch', (event) => {
  const kind = classifyRequest({
    url: event.request.url,
    method: event.request.method,
    mode: event.request.mode,
    hasRange: event.request.headers.has('Range'),
    scopeOrigin: self.location.origin,
  });
  if (kind === 'bypass') return;
  event.respondWith(kind === 'shell' ? shellFirst(event) : cacheFirst(event, kind));
});
