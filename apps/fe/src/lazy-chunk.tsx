// 按需 chunk 的加载失败兜底。React.lazy 会把 reject 永久缓存成 Rejected 并在渲染期一直抛，
// 应用里没有错误边界接得住（react-dom/server 也不支持错误边界），发版后旧 chunk 404 就是白屏。
// 这里把失败在 loader 里就地换成路由页那张重试卡片，重试重新走一次 import()；
// 连续失败到上限改成整页刷新——浏览器会把失败的模块 URL 记进 module map，
// 只有重新拿 index.html 才能指到新版 chunk。

import { PageLoadFallback } from '@/PageLoadFallback';
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

  if (loaded) {
    const Loaded = loaded;
    return <Loaded {...componentProps} />;
  }

  const retry = () => retryChunkLoad(load, (component) => setLoaded(() => component));

  return <PageLoadFallback onRetry={retry} />;
}

/**
 * 重试一次 import()：只有真正失败才计数，进行中的重试不重复发起，
 * 失败达到上限后改成整页刷新（reload 可注入以便测试）。
 */
export function retryChunkLoad<P>(
  load: ChunkLoader<P>,
  onLoaded: (component: ComponentType<P>) => void,
  reload: () => void = () => window.location.reload()
): void {
  const key = load as ChunkLoader<never>;
  if ((FAILURES.get(key) ?? 0) >= MAX_CHUNK_RETRIES) {
    reload();
    return;
  }
  if (INFLIGHT.has(key)) return;
  INFLIGHT.add(key);
  void load().then(
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
