// 按需 chunk 的加载失败兜底。React.lazy 会把 reject 永久缓存成 Rejected 并在渲染期一直抛，
// 应用里没有错误边界接得住（react-dom/server 也不支持错误边界），发版后旧 chunk 404 就是白屏。
// 这里把失败在 loader 里就地换成路由页那张重试卡片，重试重新走一次 import()；
// 连续失败到上限改成整页刷新——浏览器会把失败的模块 URL 记进 module map，
// 只有重新拿 index.html 才能指到新版 chunk。

import { PageLoadFallback } from '@/PageLoadFallback';
import { reloadAfterServiceWorkerUpdate } from '@/sw/sw-reload';
import { type ComponentType, type LazyExoticComponent, lazy, useState } from 'react';

export type ChunkLoader<P> = () => Promise<ComponentType<P>>;

/** 就地重试上限，超过后重试按钮改成整页刷新 */
export const MAX_CHUNK_RETRIES = 2;

// 重试成功后的模块按 loader 记一份：lazy 已经把「失败」定死了，不缓存的话
// 切走再切回来又会看到重试卡片。失败次数同样按 loader 记，卸载重挂不清零。
const RECOVERED = new Map<ChunkLoader<never>, ComponentType<never>>();
const FAILURES = new Map<ChunkLoader<never>, number>();
const INFLIGHT = new Set<ChunkLoader<never>>();

export function lazyChunk<P extends object>(
  load: ChunkLoader<P>
): LazyExoticComponent<ComponentType<P>> {
  return lazy(() =>
    load().then<{ default: ComponentType<P> }, { default: ComponentType<P> }>(
      (component) => ({ default: component }),
      () => ({ default: (props: P) => <ChunkRetry load={load} componentProps={props} /> })
    )
  );
}

function ChunkRetry<P extends object>({
  load,
  componentProps,
}: {
  load: ChunkLoader<P>;
  componentProps: P;
}) {
  const key = load as ChunkLoader<never>;
  const [loaded, setLoaded] = useState<ComponentType<P> | null>(
    () => (RECOVERED.get(key) as ComponentType<P> | undefined) ?? null
  );
  const [pending, setPending] = useState(false);

  if (loaded) {
    const Loaded = loaded;
    return <Loaded {...componentProps} />;
  }

  const retry = () => {
    if (pending) return;
    setPending(true);
    void retryChunkLoad(load, (component) => setLoaded(() => component)).finally(() =>
      setPending(false)
    );
  };

  // 刷新路径要先跟 waiting 的 SW 握手（最长 2 s），这段时间按钮必须禁用，
  // 否则用户连点会把「每会话一次」的守卫白白耗掉、看起来还像没反应。
  return <PageLoadFallback onRetry={retry} busy={pending} />;
}

/**
 * 重试一次 import()：只有真正失败才计数，进行中的重试不重复发起，
 * 失败达到上限后改成整页刷新（reload 可注入以便测试）。返回的 promise 在这一轮落定时 resolve，
 * 调用方据此禁用按钮。
 *
 * 刷新前先把 waiting 的 SW 顶上去：节点升级换了 fe-dist 时，旧 SW 还控制着页面，
 * 光刷新只会再拿到它那代的壳、再撞一次同样的 404；且每会话至多刷一次（见 @/sw/sw-reload）。
 */
export function retryChunkLoad<P>(
  load: ChunkLoader<P>,
  onLoaded: (component: ComponentType<P>) => void,
  reload: () => unknown = reloadAfterServiceWorkerUpdate
): Promise<void> {
  const key = load as ChunkLoader<never>;
  if ((FAILURES.get(key) ?? 0) >= MAX_CHUNK_RETRIES) {
    return Promise.resolve(reload()).then(() => undefined);
  }
  if (INFLIGHT.has(key)) return Promise.resolve();
  INFLIGHT.add(key);
  return load().then(
    (component) => {
      INFLIGHT.delete(key);
      RECOVERED.set(key, component as ComponentType<never>);
      onLoaded(component);
    },
    () => {
      INFLIGHT.delete(key);
      FAILURES.set(key, (FAILURES.get(key) ?? 0) + 1);
    }
  );
}
