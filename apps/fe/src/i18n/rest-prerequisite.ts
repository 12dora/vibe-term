// 懒面板（非路由）挂载前的语言包前置条件。
//
// 单独一个模块而不是放进 `./index`：那边用的是 vite 专属的 `import.meta.glob`，进不了单测环境；
// 面板只需要依赖这层没有任何依赖的注入点（与 `use-page-module` 的 prerequisite 同法）。
//
// 只靠 idle 预取是不够的：页面繁忙或网络调度慢时，用户可以在 `requestIdleCallback` 执行前
// 就打开面板，面板 chunk 先到就会直接显示 `connectDevices.*` 这类裸 key。

let ensureRest: (() => Promise<unknown>) | null = null;

export function setI18nRestPrerequisite(prerequisite: (() => Promise<unknown>) | null): void {
  ensureRest = prerequisite;
}

/**
 * 等 rest 语言包就位。未注入时立即 resolve（保持原有时序）；
 * 加载失败也 resolve——语言包缺失只该退化成裸 key，不该把面板永远卡在骨架上。
 */
export function awaitI18nRest(): Promise<void> {
  if (!ensureRest) return Promise.resolve();
  return ensureRest().then(
    () => undefined,
    () => undefined
  );
}

/** 懒面板 loader 的包装：模块 import 与 rest 语言包并行跑，两者都到位才挂载。 */
export function withI18nRest<T>(load: () => Promise<T>): () => Promise<T> {
  return async () => {
    const [loaded] = await Promise.all([load(), awaitI18nRest()]);
    return loaded;
  };
}
