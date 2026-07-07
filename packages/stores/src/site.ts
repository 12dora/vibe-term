import { fetchSiteSettings } from '@tmex/api-client';
import { DEFAULT_LOCALE, type SiteSettings, type ThemeMode } from '@tmex/shared';
import { buildSiteThemeUpdate } from '@tmex/ws-client';
import i18next from 'i18next';
import { create } from 'zustand';
import type { RuntimeCore } from './runtime';
import type { UIStore } from './ui';

export interface SiteState {
  settings: SiteSettings | null;
  loading: boolean;
  fetchSettings: () => Promise<SiteSettings>;
  refreshSettings: () => Promise<SiteSettings>;
  updateTheme: (theme: ThemeMode) => void;
  setThemeFromS2C: (theme: ThemeMode) => void;
}

const DEFAULT_SETTINGS: SiteSettings = {
  siteName: 'tmex',
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
  function syncThemeToUIStore(theme: ThemeMode): void {
    const uiStore = getUIStore();
    if (uiStore.getState().theme !== theme) {
      uiStore.setState({ theme });
    }
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }
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

  return create<SiteState>((set, get) => ({
    settings: null,
    loading: false,

    fetchSettings: async () => {
      const existing = get().settings;
      if (existing) {
        return existing;
      }

      set({ loading: true });
      try {
        const settings = await fetchSiteSettings(core.apiClient);
        set({ settings, loading: false });
        void i18next.changeLanguage(settings.language);
        syncThemeToUIStore(settings.theme);
        return settings;
      } catch (err) {
        console.error('[site] failed to fetch settings:', err);
        set({ settings: DEFAULT_SETTINGS, loading: false });
        void i18next.changeLanguage(DEFAULT_SETTINGS.language);
        syncThemeToUIStore(DEFAULT_SETTINGS.theme);
        return DEFAULT_SETTINGS;
      }
    },

    refreshSettings: async () => {
      set({ loading: true });
      try {
        const settings = await fetchSiteSettings(core.apiClient);
        set({ settings, loading: false });
        void i18next.changeLanguage(settings.language);
        syncThemeToUIStore(settings.theme);
        return settings;
      } catch (err) {
        console.error('[site] failed to refresh settings:', err);
        set({ loading: false });
        throw err;
      }
    },

    updateTheme: (theme) => {
      const current = get().settings;
      const nextSettings: SiteSettings = current
        ? { ...current, theme }
        : { ...DEFAULT_SETTINGS, theme };
      set({ settings: nextSettings });
      syncThemeToUIStore(theme);
      writeThemeToLocalStorage(theme);

      if (core.client.isReady()) {
        const msg = buildSiteThemeUpdate(theme);
        core.client.send(msg.kind, msg.payload);
      }
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
  }));
}

export type SiteStore = ReturnType<typeof createSiteStore>;
