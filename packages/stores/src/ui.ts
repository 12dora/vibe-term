import { DEFAULT_FONT_ID, type ThemePreset } from '@tmex/theme';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { RuntimeCore } from './runtime';

export type SidebarSection = 'panes' | 'agent' | 'files';

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
  sidebarSections: Record<SidebarSection, boolean>;
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
  setSidebarSectionOpen: (section: SidebarSection, open: boolean) => void;
  expandSidebarSection: (section: SidebarSection) => void;
  setInputMode: (mode: 'direct' | 'editor') => void;
  setKeyboardBehaviorMode: (mode: KeyboardBehaviorMode) => void;
  setEditorSendWithEnter: (enabled: boolean) => void;
  setTheme: (theme: 'light' | 'dark') => void;
  setThemePreset: (preset: ThemePreset | null) => void;
  addEditorHistory: (text: string) => void;
  setEditorDraft: (draftKey: string, text: string) => void;
  removeEditorDraft: (draftKey: string) => void;
  setTerminalFontSize: (size: number) => void;
  setTerminalLineHeight: (height: number) => void;
  setTerminalFontId: (fontId: string) => void;
}

export function createUIStore(core: Pick<RuntimeCore, 'storagePrefix'>) {
  return create<UIState>()(
    persist(
      (set) => ({
        sidebarCollapsed: false,
        sidebarSections: { panes: true, agent: true, files: true },
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
        setSidebarSectionOpen: (section, open) =>
          set((state) => ({ sidebarSections: { ...state.sidebarSections, [section]: open } })),
        expandSidebarSection: (section) =>
          set((state) =>
            state.sidebarSections[section]
              ? state
              : { sidebarSections: { ...state.sidebarSections, [section]: true } }
          ),
        setInputMode: (mode) => set({ inputMode: mode }),
        setKeyboardBehaviorMode: (mode) => set({ keyboardBehaviorMode: mode }),
        setEditorSendWithEnter: (enabled) => set({ editorSendWithEnter: enabled }),
        setTheme: (theme) => set({ theme }),
        setThemePreset: (preset) => set({ themePreset: preset }),
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
        name: `${core.storagePrefix}tmex-ui`,
        // sidebarSections 不持久化：每次加载三个分区都回到默认全展开。
        partialize: (state) => ({
          sidebarCollapsed: state.sidebarCollapsed,
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
            sidebarSections: _ignored,
            ...rest
          } = (persisted ?? {}) as Partial<UIState> & { sidebarTab?: string };
          return { ...current, ...rest };
        },
      }
    )
  );
}

export type UIStore = ReturnType<typeof createUIStore>;
