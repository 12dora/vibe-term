// 应用壳 Service Worker：iOS 主屏 PWA 每次回到前台都是冷启动，壳与资源全部走网络
// （index.html 是 no-cache，字体 2.48 MB 每次至少一次条件请求），这里把「一代构建」的
// index.html + 全部哈希资源 + 三个默认字体整体缓存下来，冷启动只剩 API 往返。
//
// 生成策略：缓存名带构建 id（版本 + 预缓存清单哈希），一次构建一代。默认不做
// skipWaiting / clients.claim——新 SW 装好自己那代缓存后等旧客户端全部退出才激活，
// 正在跑的页面始终拿到同一代的壳与 chunk，杜绝「壳更新了但 chunk 哈希已不存在」的整页刷新。
//
// 「等旧客户端退出」本身需要逃生通道，否则节点升级换掉 fe-dist 之后会卡死在旧代：
//   1) 页面发现 chunk 404 时给 waiting 的 SW 发 skipWaiting 让它立刻接管（见 ./sw-reload.ts）；
//   2) SW 自己发现**本代预缓存过的** /assets/** 在服务端已 404，就地拆掉本代并注销自己；
//   3) 本代预缓存有实质缺口时，导航放宽网络预算，缓存壳只作兜底；
//   4) 导航回放了上一代壳就告诉页面（SW_SHELL_STALE_MESSAGE），页面在下一个安全时刻换代
//      （见 ./sw-update.ts）——iOS 主屏 PWA 挂起着不退出，等「客户端全部退出」等不到头。
//
// 路由分类见 ./sw-routes，各项取舍的纯函数见 ./sw-policy（都有单测）。
// 分类为 bypass 的请求连 respondWith 都不调，由浏览器原样发出。

import { SW_SHELL_STALE_MESSAGE, SW_SKIP_WAITING_MESSAGE } from '@vibeterm/ui/sw-activation';
import {
  acceptsNetworkShell,
  isMeaningfulGap,
  planGenerationPrune,
  planGenerationSweep,
  precachePathSet,
  requestPathname,
  withGapFilled,
} from './sw-policy';
import { SHELL_URL, type SwRouteKind, classifyRequest } from './sw-routes';

// 由 vite 插件在打包 sw.js 时 define 注入
declare const __SW_BUILD_ID__: string;
declare const __SW_PRECACHE__: {
  /** 首屏必备：index.html 与它直接引用的入口 js/css + modulepreload 依赖 */
  core: readonly string[];
  /** 其余哈希 chunk（懒路由、面板、wasm）：装不上只是回落到按需下载 */
  lazy: readonly string[];
  /** 产物 CSS 静态声明的默认等宽字体（约 2.48 MB） */
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

interface SwWindowClient {
  postMessage(message: unknown): void;
}

interface SwGlobalScope {
  readonly location: { origin: string };
  readonly registration: { update(): Promise<void>; unregister(): Promise<boolean> };
  readonly clients: { matchAll(options: { type: 'window' }): Promise<readonly SwWindowClient[]> };
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

/** 本代预缓存有实质缺口时的预算：放宽但仍然有限，弱网离线不能因此一直白屏 */
const PARTIAL_SHELL_BUDGET_MS = 4000;

/** 尽力而为的预缓存并发上限：一次性发出两百多个请求会和首屏自己的数据请求抢连接 */
const OPTIONAL_PRECACHE_CONCURRENCY = 6;

/** 本代预缓存缺口清单的存放位置。只能存缓存里：SW 随时会被杀，模块变量活不过一次休眠。 */
const GAP_MARKER_URL = '/__vibeterm-sw__/partial-generation';

const PRECACHED_PATHS = precachePathSet(__SW_PRECACHE__.core, __SW_PRECACHE__.lazy);

/** 自毁之后本代缓存不该再被 caches.open 重建，剩下的请求一律直通网络 */
let destructed = false;

/** respondWith 的 promise 落定后再调 waitUntil 会抛 InvalidStateError，这里统一吞掉 */
function keepAlive(event: SwExtendableEvent, promise: Promise<unknown>): void {
  try {
    event.waitUntil(promise.catch(() => undefined));
  } catch {
    void promise.catch(() => undefined);
  }
}

/** 返回失败的 URL 列表，调用方据此重试与判定缺口 */
async function addBestEffort(cache: Cache, urls: readonly string[]): Promise<string[]> {
  const queue = [...urls];
  const lanes = Math.min(OPTIONAL_PRECACHE_CONCURRENCY, queue.length);
  const failed: string[] = [];
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
        await cache.add(url).catch(() => {
          failed.push(url);
        });
      }
    })
  );
  return failed;
}

let gapPaths: Promise<Set<string>> | null = null;

function readGapPaths(cache: Cache): Promise<Set<string>> {
  gapPaths ??= cache
    .match(GAP_MARKER_URL)
    .then((hit) => (hit ? (hit.json() as Promise<string[]>) : []))
    .then((paths) => new Set(paths))
    .catch(() => new Set<string>());
  return gapPaths;
}

async function writeGapPaths(cache: Cache, paths: Set<string>): Promise<void> {
  gapPaths = Promise.resolve(paths);
  if (paths.size === 0) {
    await cache.delete(GAP_MARKER_URL);
    return;
  }
  await cache.put(GAP_MARKER_URL, new Response(JSON.stringify([...paths])));
}

async function pruneDiscardedGenerations(): Promise<void> {
  const stale = planGenerationPrune(await caches.keys(), CACHE_PREFIX, CACHE_NAME);
  await Promise.all(stale.map((name) => caches.delete(name)));
}

async function precacheGeneration(): Promise<void> {
  const cache = await caches.open(CACHE_NAME);
  // 首屏那一批缺一不可：任一失败即放弃本代安装，宁可继续用旧代也不留半套壳
  await cache.addAll([...__SW_PRECACHE__.core]);
  // 懒 chunk 与字体是渐进增强：先逐个补，失败的整体重试一轮再判定
  const optional = [...__SW_PRECACHE__.lazy, ...__SW_PRECACHE__.fonts];
  const retried = await addBestEffort(cache, await addBestEffort(cache, optional));
  if (isMeaningfulGap(retried, __SW_PRECACHE__.fonts)) {
    await writeGapPaths(cache, new Set(retried));
  }
  await pruneDiscardedGenerations();
}

async function dropOtherGenerations(): Promise<void> {
  const stale = planGenerationSweep(await caches.keys(), CACHE_PREFIX, CACHE_NAME);
  await Promise.all(stale.map((name) => caches.delete(name)));
}

/**
 * 本代缓存里确实收录过、而服务端已经 404 的产物（节点升级换了 fe-dist）：这一代整体作废，
 * 拆掉缓存并注销自己，下一次导航直接吃服务端的新壳。之后本实例不再碰缓存，
 * 否则 caches.open 会把刚删掉的那一代又建回来。
 */
async function selfDestruct(): Promise<void> {
  destructed = true;
  gapPaths = null;
  await caches.delete(CACHE_NAME);
  await self.registration.unregister();
}

/** 命中缺口清单的运行时补齐：补上一条就从清单里划掉，清空即恢复正常预算 */
async function fillGap(cache: Cache, path: string): Promise<void> {
  const next = withGapFilled(await readGapPaths(cache), path);
  if (next) await writeGapPaths(cache, next);
}

async function cacheFirst(event: SwFetchEvent, kind: SwRouteKind): Promise<Response> {
  if (destructed) return fetch(event.request);
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(event.request);
  if (hit) return hit;
  const response = await fetch(event.request);
  const path = requestPathname(event.request.url);
  if (kind === 'asset' && response.status === 404 && path && PRECACHED_PATHS.has(path)) {
    keepAlive(event, selfDestruct());
    return response;
  }
  if (response.status === 200 && response.type === 'basic') {
    const stored = cache.put(event.request, response.clone());
    keepAlive(event, path ? stored.then(() => fillGap(cache, path)) : stored);
  }
  return response;
}

/** 网络优先但带预算；超时连同在途请求一起 abort，别把连接挂在那儿 */
function raceShellNetwork(request: Request, budgetMs: number): Promise<Response | null> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, budgetMs);
    const settle = (response: Response | null) => {
      clearTimeout(timer);
      resolve(response);
    };
    fetch(request, { signal: controller.signal }).then(
      (response) => settle(acceptsNetworkShell(response.status, response.type) ? response : null),
      () => settle(null)
    );
  });
}

/**
 * 导航：先给服务端一个预算接管（访问门、302），超时或拿到 5xx 才回放本代缓存的壳，
 * 同时触发一次 SW 更新检查。**不**把新 index.html 写回本代缓存——新壳配旧 chunk 哈希
 * 正是要避免的组合，换代由新 SW 装好新一代缓存后完成。
 */
async function shellFirst(event: SwFetchEvent): Promise<Response> {
  if (destructed) return fetch(event.request);
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(SHELL_URL);
  if (!cached) return fetch(event.request);
  const gaps = await readGapPaths(cache);
  const budget = gaps.size > 0 ? PARTIAL_SHELL_BUDGET_MS : SHELL_NETWORK_BUDGET_MS;
  const network = await raceShellNetwork(event.request, budget);
  if (network) return network;
  keepAlive(event, Promise.all([self.registration.update(), announceShellStale()]));
  return cached;
}

/**
 * 告诉页面「你手上这张壳是上一代的」。页面据此在下一个安全时刻换代——新一代可能是上一次
 * 会话里就装好的，那一代 `updatefound` 早就发过了，只靠事件的页面永远等不到。
 */
async function announceShellStale(): Promise<void> {
  const windows = await self.clients.matchAll({ type: 'window' });
  for (const client of windows) client.postMessage({ type: SW_SHELL_STALE_MESSAGE });
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
