import { FeatureSet, fetchCapabilities, fetchSiteSettings } from '@tmex/api-client';
import { DEFAULT_LOCALE, PRODUCT_NAME, type SiteSettings, type ThemeMode } from '@tmex/shared';
import { THEME_PRESET_META, type ThemeAppearance, type ThemePreset } from '@tmex/theme';
import { buildSiteThemeUpdate } from '@tmex/ws-client';
import i18next from 'i18next';
import { create } from 'zustand';
import type { RuntimeCore } from './runtime';
import type { UIStore } from './ui';

export interface SiteState {
  settings: SiteSettings | null;
  loading: boolean;
  /** 服务端能力集（GET /api/capabilities）；消费方按 featureset 决定渲染，默认空集 */
  capabilities: FeatureSet;
  fetchSettings: () => Promise<SiteSettings>;
  refreshSettings: () => Promise<SiteSettings>;
  loadCapabilities: () => Promise<void>;
  updateTheme: (theme: ThemeMode) => void;
  setThemeFromS2C: (theme: ThemeMode) => void;
  /**
   * 主题预设选择入口：预设自带亮/暗外观，选中即把站点外观同步过去（走 updateTheme 上行）；
   * 传 null 回到无预设，外观取 fallbackAppearance，缺省保持当前。
   */
  selectThemePreset: (preset: ThemePreset | null, fallbackAppearance?: ThemeAppearance) => void;
  /**
   * S2C 设置变更信号的缓存失效入口。只有 'site' 对应本 store 缓存的 SiteSettings；
   * 'theme' 另有 SITE_THEME_UPDATE 专用帧，其余 namespace 的缓存在各自消费方（react-query）。
   */
  handleSettingsUpdate: (namespace: string) => void;
}

const DEFAULT_SETTINGS: SiteSettings = {
  siteName: PRODUCT_NAME,
  siteUrl: typeof window !== 'undefined' ? window.location.origin : 'http://localhost:9663',
  bellThrottleSeconds: 6,
  notificationThrottleSeconds: 3,
  enableBrowserNotificationToast: true,
  enableNotificationPush: true,
  enableBellPush: true,
  enableBellSound: true,
  sshReconnectMaxRetries: 2,
  sshReconnectDelaySeconds: 10,
  language: DEFAULT_LOCALE,
  theme: 'dark' as ThemeMode,
  disabledNotificationChannels: [],
  updatedAt: new Date(0).toISOString(),
};

export function createSiteStore(
  core: Pick<RuntimeCore, 'client' | 'apiClient' | 'storagePrefix'>,
  getUIStore: () => UIStore
) {
  // 外观一变（服务端下发或用户直接切亮/暗），当前预设若属于另一套外观就不再适用：
  // 深色预设的 token 依赖 <html>.dark 才成立，留着会得到深底浅字的混搭。
  function syncThemeToUIStore(theme: ThemeMode): void {
    const uiStore = getUIStore();
    // 同源另一标签页可能刚改过外观/预设：先把共享 localStorage 的最新值同步进内存，
    // 失配清理才不会拿陈旧内存值把对方的选择擦掉并回写。
    uiStore.getState().syncThemeFromStorage();
    const { theme: currentTheme, themePreset } = uiStore.getState();
    const patch: { theme?: ThemeMode; themePreset?: ThemePreset | null } = {};
    if (currentTheme !== theme) {
      patch.theme = theme;
    }
    if (themePreset && THEME_PRESET_META[themePreset].appearance !== theme) {
      patch.themePreset = null;
    }
    if (patch.theme !== undefined || patch.themePreset !== undefined) {
      uiStore.setState(patch);
    }
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }
  }

  // S2C 失效信号可能连着来，多个 REST 重拉会并发在途；只允许最新一次提交，
  // 否则慢的旧响应后到就会把新设置（含 theme/language）盖回旧值
  let settingsGeneration = 0;

  function beginSettingsRequest(): number {
    settingsGeneration += 1;
    return settingsGeneration;
  }

  function isLatestSettingsRequest(generation: number): boolean {
    return generation === settingsGeneration;
  }

  // 本地主题变更（切外观 / 选预设）立刻成为最新事实：在途 settings 响应回来时已是旧数据，
  // 直接作废，否则它会把刚选的外观写回去并连带清掉预设。
  function invalidateSettingsRequests(): void {
    settingsGeneration += 1;
  }

  function writeThemeToLocalStorage(theme: ThemeMode): void {
    try {
      const key = `${core.storagePrefix}tmex-ui`;
      const raw = localStorage.getItem(key);
      const parsed = raw ? (JSON.parse(raw) as { state?: { theme?: unknown } }) : { state: {} };
      parsed.state = { ...(parsed.state ?? {}), theme };
      localStorage.setItem(key, JSON.stringify(parsed));
    } catch {
      // localStorage 不可用时静默降级（离线 fallback 仅在可用时生效）
    }
  }

  return create<SiteState>((set, get) => {
    function commitSettings(settings: SiteSettings): void {
      set({ settings, loading: false });
      void i18next.changeLanguage(settings.language);
      syncThemeToUIStore(settings.theme);
    }

    return {
      settings: null,
      loading: false,
      capabilities: FeatureSet.empty(),

      fetchSettings: async () => {
        const existing = get().settings;
        if (existing) {
          return existing;
        }

        const generation = beginSettingsRequest();
        set({ loading: true });
        try {
          const settings = await fetchSiteSettings(core.apiClient);
          if (!isLatestSettingsRequest(generation)) {
            return get().settings ?? settings;
          }
          commitSettings(settings);
          return settings;
        } catch (err) {
          console.error('[site] failed to fetch settings:', err);
          if (!isLatestSettingsRequest(generation)) {
            return get().settings ?? DEFAULT_SETTINGS;
          }
          commitSettings(DEFAULT_SETTINGS);
          return DEFAULT_SETTINGS;
        }
      },

      refreshSettings: async () => {
        const generation = beginSettingsRequest();
        set({ loading: true });
        try {
          const settings = await fetchSiteSettings(core.apiClient);
          // 已有更新的重拉在途/已提交：这次响应是旧数据，只返回不落库
          if (!isLatestSettingsRequest(generation)) {
            return get().settings ?? settings;
          }
          commitSettings(settings);
          return settings;
        } catch (err) {
          console.error('[site] failed to refresh settings:', err);
          if (isLatestSettingsRequest(generation)) {
            set({ loading: false });
          }
          throw err;
        }
      },

      loadCapabilities: async () => {
        try {
          const res = await fetchCapabilities(core.apiClient);
          set({ capabilities: new FeatureSet(res.capabilities) });
        } catch (err) {
          console.error('[site] failed to load capabilities:', err);
        }
      },

      updateTheme: (theme) => {
        invalidateSettingsRequests();
        const current = get().settings;
        const nextSettings: SiteSettings = current
          ? { ...current, theme }
          : { ...DEFAULT_SETTINGS, theme };
        // 在途请求已作废，不会再有人复位 loading，这里一并落回
        set({ settings: nextSettings, loading: false });
        syncThemeToUIStore(theme);
        writeThemeToLocalStorage(theme);

        if (core.client.isReady()) {
          const msg = buildSiteThemeUpdate(theme);
          core.client.send(msg.kind, msg.payload);
        }
      },

      handleSettingsUpdate: (namespace) => {
        if (namespace !== 'site') {
          return;
        }
        void get()
          .refreshSettings()
          .catch(() => {
            // refreshSettings 内部已记录失败；失效信号丢一次不影响后续读取
          });
      },

      selectThemePreset: (preset, fallbackAppearance) => {
        const uiStore = getUIStore();
        // 先落预设再改外观：syncThemeToUIStore 的失配清理据此看到的是新预设，外观一致故不会被清掉
        uiStore.getState().setThemePreset(preset);
        const appearance = preset
          ? THEME_PRESET_META[preset].appearance
          : (fallbackAppearance ?? uiStore.getState().theme);
        get().updateTheme(appearance);
      },

      setThemeFromS2C: (theme) => {
        const current = get().settings;
        const nextSettings: SiteSettings = current
          ? { ...current, theme }
          : { ...DEFAULT_SETTINGS, theme };
        set({ settings: nextSettings });
        syncThemeToUIStore(theme);
        writeThemeToLocalStorage(theme);
      },
    };
  });
}

export type SiteStore = ReturnType<typeof createSiteStore>;
