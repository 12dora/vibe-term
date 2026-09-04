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
  /**
   * 取数失败时落兜底值，返回真正落库的那份。与 commit 分开是因为失败不得把 UI 语言掀回默认值：
   * 401（未登录）/ 网络抖动都会走到这里，提交 DEFAULT_SETTINGS.language 就等于
   * 把中文界面主动切成英文，直到设置页某次请求成功才能改回来。
   */
  commitFallback: (settings: SiteSettings) => SiteSettings;
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

interface InflightRequest {
  /** 请求发出那一刻分配的代次，终生不变：搭车方不会把它顶掉 */
  generation: number;
  promise: Promise<SiteSettings>;
}

export function createSiteSettingsLoader(options: SiteSettingsLoaderOptions): SiteSettingsLoader {
  // S2C 失效信号可能连着来，多个 REST 重拉会并发在途；只允许最新一次提交，
  // 否则慢的旧响应后到就会把新设置（含 theme/language）盖回旧值。
  // 代次绑在物理请求上而非调用方：invalidate() 之后在途请求既不可搭车也不可提交。
  let generation = 0;
  // 侧栏引导与设置页表单会同时要站点设置：在途的那次请求共享给所有等待方。
  // 只有 fetchSettings / ensureFreshSettings 允许搭车；refreshSettings 一定另起一次——
  // 它跑在 PATCH 成功或 S2C 失效之后，搭上变更之前发出的请求会拿回旧数据。
  let inflight: InflightRequest | null = null;

  function commitIfCurrent(requestGeneration: number, settings: SiteSettings): SiteSettings {
    // 已有更新的重拉在途/已提交，或期间被 invalidate：这次响应是旧数据，只返回不落库
    if (requestGeneration !== generation) {
      return options.current() ?? settings;
    }
    options.commit(settings);
    return settings;
  }

  function commitFallbackIfCurrent(requestGeneration: number): SiteSettings {
    if (requestGeneration !== generation) {
      return options.current() ?? options.fallback;
    }
    return options.commitFallback(options.fallback);
  }

  function release(requestGeneration: number): void {
    if (inflight?.generation === requestGeneration) {
      inflight = null;
    }
  }

  // 提交与失败清理都由发起这次物理请求的所有者完成，搭车方只等结果，与搭车顺序无关
  function start(): InflightRequest {
    generation += 1;
    const requestGeneration = generation;
    options.setLoading(true);
    const promise = options.request().then(
      (settings) => {
        release(requestGeneration);
        return commitIfCurrent(requestGeneration, settings);
      },
      (err: unknown) => {
        release(requestGeneration);
        console.error('[site] failed to load settings:', err);
        // 已被更新的请求接手时，复位 loading 的责任归最新那次
        if (requestGeneration === generation) {
          options.setLoading(false);
        }
        throw err;
      }
    );
    const entry: InflightRequest = { generation: requestGeneration, promise };
    inflight = entry;
    return entry;
  }

  function acquire(join: boolean): InflightRequest {
    // 代次对不上说明它已被 invalidate 或被更新的请求取代，搭车只会拿回过期数据
    if (join && inflight && inflight.generation === generation) {
      return inflight;
    }
    return start();
  }

  return {
    fetchSettings: async () => {
      const existing = options.current();
      if (existing) {
        return existing;
      }
      const entry = acquire(true);
      try {
        return await entry.promise;
      } catch {
        // 失败已由所有者记过日志；引导路径不抛，落兜底值让 UI 起得来
        return options.current() ?? commitFallbackIfCurrent(entry.generation);
      }
    },

    ensureFreshSettings: () => acquire(true).promise,

    refreshSettings: () => acquire(false).promise,

    invalidate: () => {
      generation += 1;
    },
  };
}
