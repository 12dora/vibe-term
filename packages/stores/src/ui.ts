import { DEFAULT_FONT_ID, type ThemePreset, isThemePreset } from '@tmex/theme';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { RuntimeCore } from './runtime';

export type SidebarTab = 'panes' | 'agent' | 'files';

/** 持久化的 `key -> boolean` 偏好表可能被手工改坏，只保留合法的布尔项 */
function normalizeBooleanMap(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, boolean> = {};
  for (const [key, flag] of Object.entries(value)) {
    if (typeof flag === 'boolean') {
      normalized[key] = flag;
    }
  }
  return normalized;
}

/** 持久化的 id 顺序表可能被手工改坏，只保留非空字符串并去重 */
function normalizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

// 预设名单会随版本增删，localStorage 里可能残留已下线的 id（会命中不存在的 CSS 规则）。
function normalizeThemePreset(value: unknown): ThemePreset | null {
  return isThemePreset(value) ? value : null;
}

interface PersistedThemeState {
  theme?: 'light' | 'dark';
  themePreset?: ThemePreset | null;
}

/** 从持久化 JSON 中取外观/预设；缺字段即「未写过」，不参与同步（区别于显式的 null 预设） */
function readPersistedThemeState(raw: string | null): PersistedThemeState {
  if (!raw) {
    return {};
  }
  let state: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as { state?: unknown } | null;
    if (!parsed?.state || typeof parsed.state !== 'object') {
      return {};
    }
    state = parsed.state as Record<string, unknown>;
  } catch {
    return {};
  }

  const snapshot: PersistedThemeState = {};
  if (state.theme === 'light' || state.theme === 'dark') {
    snapshot.theme = state.theme;
  }
  if ('themePreset' in state) {
    snapshot.themePreset = normalizeThemePreset(state.themePreset);
  }
  return snapshot;
}

function readStorageItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// 终端字体设置默认值（与 ghostty-terminal 内置默认保持一致）。
const DEFAULT_TERMINAL_FONT_SIZE = 13;
const DEFAULT_TERMINAL_LINE_HEIGHT = 1.2;

// 手机虚拟键盘弹出时的页面避让策略（issue #27）。
// lift=页面平移（整页上移，终端尺寸不变，0.12.0 现状）；
// resize=终端缩放（缩到键盘上方可用高度，会触发远端 resize）；
// follow=光标对齐（按光标位置上移，光标始终在键盘上方，终端尺寸不变）。
export type KeyboardBehaviorMode = 'lift' | 'resize' | 'follow';

export interface UIState {
  sidebarCollapsed: boolean;
  sidebarTab: SidebarTab;
  sidebarDeviceExpanded: Record<string, boolean>;
  /** 设备是否出现在侧边栏；key 为 `${runtimeNodeId}:${deviceId}`（见 sidebar-device-visibility.ts） */
  sidebarDeviceVisibility: Record<string, boolean>;
  /** 设备管理页文件夹的展开态；key 为文件夹 id，缺键视为展开 */
  deviceFolderExpanded: Record<string, boolean>;
  /** 侧边栏 node 分节的手工顺序（mesh node id）；未列出的 node 按 API 顺序排在后面 */
  sidebarNodeOrder: string[];
  inputMode: 'direct' | 'editor';
  editorSendWithEnter: boolean;
  theme: 'light' | 'dark';
  themePreset: ThemePreset | null;
  keyboardBehaviorMode: KeyboardBehaviorMode;
  editorHistory: string[];
  editorDrafts: Record<string, string>;
  // 终端字体（每设备本地持久化）：字号/行高仅作用于终端，字体族经 --font-mono 全应用统一。
  terminalFontSize: number;
  terminalLineHeight: number;
  terminalFontId: string;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  setSidebarDeviceExpanded: (deviceId: string, expanded: boolean) => void;
  /** key 由 `sidebarDeviceVisibilityKey(runtimeNodeId, deviceId)` 生成 */
  setSidebarDeviceVisibility: (key: string, visible: boolean) => void;
  setDeviceFolderExpanded: (folderId: string, expanded: boolean) => void;
  setSidebarNodeOrder: (nodeIds: string[]) => void;
  setInputMode: (mode: 'direct' | 'editor') => void;
  setKeyboardBehaviorMode: (mode: KeyboardBehaviorMode) => void;
  setEditorSendWithEnter: (enabled: boolean) => void;
  setTheme: (theme: 'light' | 'dark') => void;
  setThemePreset: (preset: ThemePreset | null) => void;
  /** 从共享的 localStorage 快照补齐外观/预设（同源另一标签页改过时用） */
  syncThemeFromStorage: () => void;
  addEditorHistory: (text: string) => void;
  setEditorDraft: (draftKey: string, text: string) => void;
  removeEditorDraft: (draftKey: string) => void;
  setTerminalFontSize: (size: number) => void;
  setTerminalLineHeight: (height: number) => void;
  setTerminalFontId: (fontId: string) => void;
}

export function createUIStore(core: Pick<RuntimeCore, 'storagePrefix'>) {
  const storageKey = `${core.storagePrefix}tmex-ui`;

  const store = create<UIState>()(
    persist(
      (set, get) => ({
        sidebarCollapsed: false,
        sidebarTab: 'panes',
        sidebarDeviceExpanded: {},
        sidebarDeviceVisibility: {},
        deviceFolderExpanded: {},
        sidebarNodeOrder: [],
        inputMode: 'direct',
        editorSendWithEnter: true,
        theme: 'dark',
        themePreset: null,
        keyboardBehaviorMode: 'follow',
        editorHistory: [],
        editorDrafts: {},
        terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
        terminalLineHeight: DEFAULT_TERMINAL_LINE_HEIGHT,
        terminalFontId: DEFAULT_FONT_ID,

        setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
        setSidebarTab: (tab) => set({ sidebarTab: tab }),
        setSidebarDeviceExpanded: (deviceId, expanded) =>
          set((state) => ({
            sidebarDeviceExpanded: { ...state.sidebarDeviceExpanded, [deviceId]: expanded },
          })),
        setSidebarDeviceVisibility: (key, visible) =>
          set((state) => ({
            sidebarDeviceVisibility: { ...state.sidebarDeviceVisibility, [key]: visible },
          })),
        setDeviceFolderExpanded: (folderId, expanded) =>
          set((state) => ({
            deviceFolderExpanded: { ...state.deviceFolderExpanded, [folderId]: expanded },
          })),
        setSidebarNodeOrder: (nodeIds) => set({ sidebarNodeOrder: normalizeIdList(nodeIds) }),
        setInputMode: (mode) => set({ inputMode: mode }),
        setKeyboardBehaviorMode: (mode) => set({ keyboardBehaviorMode: mode }),
        setEditorSendWithEnter: (enabled) => set({ editorSendWithEnter: enabled }),
        setTheme: (theme) => set({ theme }),
        setThemePreset: (preset) => set({ themePreset: normalizeThemePreset(preset) }),
        syncThemeFromStorage: () => {
          const snapshot = readPersistedThemeState(readStorageItem(storageKey));
          const state = get();
          const patch: { theme?: 'light' | 'dark'; themePreset?: ThemePreset | null } = {};
          if (snapshot.theme && snapshot.theme !== state.theme) {
            patch.theme = snapshot.theme;
          }
          if (snapshot.themePreset !== undefined && snapshot.themePreset !== state.themePreset) {
            patch.themePreset = snapshot.themePreset;
          }
          // 无差异不 set：同值回写会与另一标签页的监听互相触发
          if (patch.theme !== undefined || patch.themePreset !== undefined) {
            set(patch);
          }
        },
        setTerminalFontSize: (size) => set({ terminalFontSize: size }),
        setTerminalLineHeight: (height) => set({ terminalLineHeight: height }),
        setTerminalFontId: (fontId) => set({ terminalFontId: fontId }),

        addEditorHistory: (text) =>
          set((state) => ({
            editorHistory: [text, ...state.editorHistory.slice(0, 49)],
          })),

        setEditorDraft: (draftKey, text) =>
          set((state) => ({
            editorDrafts: {
              ...state.editorDrafts,
              [draftKey]: text,
            },
          })),

        removeEditorDraft: (draftKey) =>
          set((state) => {
            if (!(draftKey in state.editorDrafts)) {
              return state;
            }
            const nextDrafts = { ...state.editorDrafts };
            delete nextDrafts[draftKey];
            return { editorDrafts: nextDrafts };
          }),
      }),
      {
        name: storageKey,
        // sidebarTab 不持久化：每次加载都回到默认 'panes'。
        partialize: (state) => ({
          sidebarCollapsed: state.sidebarCollapsed,
          sidebarDeviceExpanded: state.sidebarDeviceExpanded,
          sidebarDeviceVisibility: state.sidebarDeviceVisibility,
          deviceFolderExpanded: state.deviceFolderExpanded,
          sidebarNodeOrder: state.sidebarNodeOrder,
          inputMode: state.inputMode,
          editorSendWithEnter: state.editorSendWithEnter,
          theme: state.theme,
          themePreset: state.themePreset,
          keyboardBehaviorMode: state.keyboardBehaviorMode,
          editorHistory: state.editorHistory,
          editorDrafts: state.editorDrafts,
          terminalFontSize: state.terminalFontSize,
          terminalLineHeight: state.terminalLineHeight,
          terminalFontId: state.terminalFontId,
        }),
        // 丢弃旧版本 localStorage 里残留的 sidebarTab/sidebarSections，避免被默认 merge 带回。
        merge: (persisted, current) => {
          const {
            sidebarTab: _legacyTab,
            sidebarSections: _legacySections,
            sidebarDeviceExpanded,
            sidebarDeviceVisibility,
            deviceFolderExpanded,
            sidebarNodeOrder,
            themePreset,
            ...rest
          } = (persisted ?? {}) as Partial<UIState> & {
            sidebarSections?: unknown;
          };
          return {
            ...current,
            ...rest,
            sidebarDeviceExpanded: normalizeBooleanMap(sidebarDeviceExpanded),
            sidebarDeviceVisibility: normalizeBooleanMap(sidebarDeviceVisibility),
            deviceFolderExpanded: normalizeBooleanMap(deviceFolderExpanded),
            sidebarNodeOrder: normalizeIdList(sidebarNodeOrder),
            themePreset: normalizeThemePreset(themePreset),
          };
        },
      }
    )
  );

  subscribeThemeStorageSync(store, storageKey);
  return store;
}

export type UIStore = ReturnType<typeof createUIStore>;

/**
 * 同源多标签页共用一份 localStorage：另一标签页改了外观/预设后本页内存 store 仍是旧值，
 * 随后到达的 S2C 外观帧会据此误判失配，把对方刚写入的预设清成 null 并回写覆盖。
 */
function subscribeThemeStorageSync(store: { getState: () => UIState }, storageKey: string): void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return;
  }
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key !== storageKey) {
      return;
    }
    store.getState().syncThemeFromStorage();
  });
}
