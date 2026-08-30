// 站点设置的取数策略，从 site store 里拆出来：请求代次（旧响应不得覆盖新数据）
// 与在途请求共享（并发调用只出一次 GET）都只在这里成立，store 只管提交结果。

import type { SiteSettings } from '@tmex/shared';

export interface SiteSettingsLoaderOptions {
  /** 发一次真实请求（store 注入，避免这里再依赖 api-client） */
  request: () => Promise<SiteSettings>;
  /** store 里当前的设置，没有就是 null */
  current: () => SiteSettings | null;
  setLoading: (loading: boolean) => void;
  /** 落库并做语言 / 主题同步 */
  commit: (settings: SiteSettings) => void;
  /** 取数失败时的兜底设置 */
  fallback: SiteSettings;
}

export interface SiteSettingsLoader {
  /** 引导用：已有缓存直接返回，否则复用在途请求或发起一次；失败落兜底值，不抛 */
  fetchSettings: () => Promise<SiteSettings>;
  /** 不吃缓存但可复用在途请求 */
  ensureFreshSettings: () => Promise<SiteSettings>;
  /** 一定新发一次请求 */
  refreshSettings: () => Promise<SiteSettings>;
  /** 本地主题变更后作废在途响应（它带的是变更前的外观） */
  invalidate: () => void;
}

export function createSiteSettingsLoader(options: SiteSettingsLoaderOptions): SiteSettingsLoader {
  // S2C 失效信号可能连着来，多个 REST 重拉会并发在途；只允许最新一次提交，
  // 否则慢的旧响应后到就会把新设置（含 theme/language）盖回旧值
  let generation = 0;
  // 侧栏引导与设置页表单会同时要站点设置：在途的那次请求共享给所有等待方。
  // 只有 fetchSettings / ensureFreshSettings 允许搭车；refreshSettings 一定另起一次——
  // 它跑在 PATCH 成功或 S2C 失效之后，搭上变更之前发出的请求会拿回旧数据。
  let inflight: Promise<SiteSettings> | null = null;

  function send(join: boolean): Promise<SiteSettings> {
    if (join && inflight) {
      return inflight;
    }
    const request = options.request().finally(() => {
      if (inflight === request) {
        inflight = null;
      }
    });
    inflight = request;
    return request;
  }

  function commitIfLatest(requestGeneration: number, settings: SiteSettings): SiteSettings {
    // 已有更新的重拉在途/已提交：这次响应是旧数据，只返回不落库
    if (requestGeneration !== generation) {
      return options.current() ?? settings;
    }
    options.commit(settings);
    return settings;
  }

  function begin(): number {
    generation += 1;
    options.setLoading(true);
    return generation;
  }

  async function load(join: boolean): Promise<SiteSettings> {
    const requestGeneration = begin();
    try {
      return commitIfLatest(requestGeneration, await send(join));
    } catch (err) {
      console.error('[site] failed to refresh settings:', err);
      // 在途请求已作废时，复位 loading 的责任归最新那次
      if (requestGeneration === generation) {
        options.setLoading(false);
      }
      throw err;
    }
  }

  return {
    fetchSettings: async () => {
      const existing = options.current();
      if (existing) {
        return existing;
      }
      const requestGeneration = begin();
      try {
        return commitIfLatest(requestGeneration, await send(true));
      } catch (err) {
        console.error('[site] failed to fetch settings:', err);
        return commitIfLatest(requestGeneration, options.fallback);
      }
    },

    ensureFreshSettings: () => load(true),

    refreshSettings: () => load(false),

    invalidate: () => {
      generation += 1;
    },
  };
}
