import { DEFAULT_LOCALE, type SiteSettings, type ThemeMode } from '@tmex/shared';
import { create } from 'zustand';
import i18n from '../i18n';
import { buildSiteThemeUpdate, getBorshClient } from '../ws-borsh';
import { useUIStore } from './ui';

interface SiteState {
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
  updatedAt: new Date(0).toISOString(),
};

async function fetchSiteSettingsFromApi(): Promise<SiteSettings> {
  const res = await fetch('/api/settings/site');
  if (!res.ok) {
    throw new Error('Failed to load site settings');
  }
  const payload = (await res.json()) as { settings: SiteSettings };
  return payload.settings;
}

function syncThemeToUIStore(theme: ThemeMode): void {
  if (useUIStore.getState().theme !== theme) {
    useUIStore.setState({ theme });
  }
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }
}

function writeThemeToLocalStorage(theme: ThemeMode): void {
  try {
    const raw = localStorage.getItem('tmex-ui');
    const parsed = raw ? (JSON.parse(raw) as { state?: { theme?: unknown } }) : { state: {} };
    parsed.state = { ...(parsed.state ?? {}), theme };
    localStorage.setItem('tmex-ui', JSON.stringify(parsed));
  } catch {
    // localStorage 不可用时静默降级（离线 fallback 仅在可用时生效）
  }
}

export const useSiteStore = create<SiteState>((set, get) => ({
  settings: null,
  loading: false,

  fetchSettings: async () => {
    const existing = get().settings;
    if (existing) {
      return existing;
    }

    set({ loading: true });
    try {
      const settings = await fetchSiteSettingsFromApi();
      set({ settings, loading: false });
      void i18n.changeLanguage(settings.language);
      syncThemeToUIStore(settings.theme);
      return settings;
    } catch (err) {
      console.error('[site] failed to fetch settings:', err);
      set({ settings: DEFAULT_SETTINGS, loading: false });
      void i18n.changeLanguage(DEFAULT_SETTINGS.language);
      syncThemeToUIStore(DEFAULT_SETTINGS.theme);
      return DEFAULT_SETTINGS;
    }
  },

  refreshSettings: async () => {
    set({ loading: true });
    try {
      const settings = await fetchSiteSettingsFromApi();
      set({ settings, loading: false });
      void i18n.changeLanguage(settings.language);
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

    const client = getBorshClient();
    if (client.isReady()) {
      const msg = buildSiteThemeUpdate(theme);
      client.send(msg.kind, msg.payload);
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
