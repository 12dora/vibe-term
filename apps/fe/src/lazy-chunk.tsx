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
// 切走再切回来又会看到重试卡片。
const RECOVERED = new Map<ChunkLoader<never>, ComponentType<never>>();

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
  const [attempts, setAttempts] = useState(0);

  if (loaded) {
    const Loaded = loaded;
    return <Loaded {...componentProps} />;
  }

  const retry = () => {
    if (attempts >= MAX_CHUNK_RETRIES) {
      window.location.reload();
      return;
    }
    setAttempts((n) => n + 1);
    void load().then((component) => {
      RECOVERED.set(key, component as ComponentType<never>);
      setLoaded(() => component);
    }, noop);
  };

  return <PageLoadFallback onRetry={retry} />;
}

/** 重试失败继续留在重试卡片上，不需要额外处理 */
function noop(): void {}
