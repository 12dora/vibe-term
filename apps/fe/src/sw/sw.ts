// 应用壳 Service Worker：iOS 主屏 PWA 每次回到前台都是冷启动，壳与资源全部走网络
// （index.html 是 no-cache，字体 2.48 MB 每次至少一次条件请求），这里把「一代构建」的
// index.html + 全部哈希资源 + 三个默认字体整体缓存下来，冷启动只剩 API 往返。
//
// 生成策略：缓存名带构建 id（版本 + 预缓存清单哈希），一次构建一代。刻意不做
// skipWaiting / clients.claim——新 SW 装好自己那代缓存后等旧客户端全部退出才激活，
// 正在跑的页面始终拿到同一代的壳与 chunk，杜绝「壳更新了但 chunk 哈希已不存在」的整页刷新。
//
// 路由分类见 ./sw-routes（纯函数，单测覆盖）。分类为 bypass 的请求连 respondWith 都不调，
// 由浏览器原样发出。

import { SHELL_URL, classifyRequest } from './sw-routes';

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

interface SwClient {
  postMessage(message: unknown): void;
}

interface SwGlobalScope {
  readonly location: { origin: string };
  readonly clients: {
    matchAll(options?: { includeUncontrolled?: boolean; type?: string }): Promise<SwClient[]>;
  };
  readonly registration: { update(): Promise<void> };
  addEventListener(
    type: 'install' | 'activate',
    listener: (event: SwExtendableEvent) => void
  ): void;
  addEventListener(type: 'fetch', listener: (event: SwFetchEvent) => void): void;
}

declare const self: SwGlobalScope;

const CACHE_PREFIX = 'vibeterm-shell-';
const CACHE_NAME = `${CACHE_PREFIX}${__SW_BUILD_ID__}`;
const UPDATE_MESSAGE = { type: 'vibeterm:sw-updated', buildId: __SW_BUILD_ID__ };

/** respondWith 的 promise 落定后再调 waitUntil 会抛 InvalidStateError，这里统一吞掉 */
function keepAlive(event: SwExtendableEvent, promise: Promise<unknown>): void {
  try {
    event.waitUntil(promise.catch(() => undefined));
  } catch {
    void promise.catch(() => undefined);
  }
}

/** 尽力而为的预缓存并发上限：一次性发出两百多个请求会和首屏自己的数据请求抢连接 */
const OPTIONAL_PRECACHE_CONCURRENCY = 6;

async function addBestEffort(cache: Cache, urls: readonly string[]): Promise<void> {
  const queue = [...urls];
  const lanes = Math.min(OPTIONAL_PRECACHE_CONCURRENCY, queue.length);
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
        await cache.add(url).catch(() => undefined);
      }
    })
  );
}

async function precacheGeneration(): Promise<void> {
  const cache = await caches.open(CACHE_NAME);
  // 首屏那一批缺一不可：任一失败即放弃本代安装，宁可继续用旧代也不留半套壳
  await cache.addAll([...__SW_PRECACHE__.core]);
  // 懒 chunk 与字体是渐进增强，逐个补、失败只回落到按需下载
  await addBestEffort(cache, [...__SW_PRECACHE__.lazy, ...__SW_PRECACHE__.fonts]);
}

async function dropOtherGenerations(): Promise<void> {
  const names = await caches.keys();
  const stale = names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME);
  await Promise.all(stale.map((name) => caches.delete(name)));
}

async function notifyClients(): Promise<void> {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  for (const client of clients) {
    client.postMessage(UPDATE_MESSAGE);
  }
}

async function cacheFirst(event: SwFetchEvent): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(event.request);
  if (hit) return hit;
  const response = await fetch(event.request);
  if (response.status === 200 && response.type === 'basic') {
    keepAlive(event, cache.put(event.request, response.clone()));
  }
  return response;
}

/**
 * 导航：直接回放本代缓存的壳，后台只触发 SW 更新检查，**不**把新 index.html 写回本代缓存——
 * 新壳配旧 chunk 哈希正是要避免的组合。真正的换代由新 SW 装好新一代缓存后完成。
 */
async function shellFirst(event: SwFetchEvent): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(SHELL_URL);
  if (!cached) return fetch(event.request);
  keepAlive(event, self.registration.update());
  return cached;
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheGeneration());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(dropOtherGenerations().then(notifyClients));
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
  event.respondWith(kind === 'shell' ? shellFirst(event) : cacheFirst(event));
});
