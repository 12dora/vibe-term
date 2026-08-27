// 终端快捷键编辑器的数据层：草稿态、与服务器基线的对齐、增删改排序与保存。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type ApiClient,
  fetchTerminalShortcuts,
  terminalShortcutsQueryKey,
  updateTerminalShortcuts,
} from '@tmex/api-client';
import {
  DEFAULT_TERMINAL_SHORTCUTS,
  type TerminalShortcutAction,
  type TerminalShortcutItem,
  type TerminalShortcutSettings,
  type UpdateTerminalShortcutSettingsRequest,
} from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { keyEventToTerminalSequence, parseEscapeSequence } from '@tmex/terminal-ui';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

export interface ShortcutDraftSnapshot {
  items: TerminalShortcutItem[];
  useIcons: boolean;
}

export function newShortcutId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `sc-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

// 按固定字段顺序归一化后比较，规避对象键顺序差异（服务端规范化 vs 前端构造）造成的假阳性。
function normItem(item: TerminalShortcutItem): string {
  return JSON.stringify([
    item.id,
    item.type,
    item.label,
    item.payload ?? null,
    item.action ?? null,
  ]);
}

export function sameShortcutItems(a: TerminalShortcutItem[], b: TerminalShortcutItem[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => normItem(item) === normItem(b[index]));
}

export function isShortcutDraftDirty(
  draft: ShortcutDraftSnapshot,
  baseline: ShortcutDraftSnapshot | null
): boolean {
  if (!baseline) return false;
  return !sameShortcutItems(draft.items, baseline.items) || draft.useIcons !== baseline.useIcons;
}

/**
 * 是否采纳服务器值：未初始化必采纳；已初始化时仅当服务器相对基线有变化、且用户草稿未被编辑，
 * 既消除假 dirty、也避免用陈旧草稿盲覆盖他端更新。
 * 注意：用户正在编辑（dirty）时发生的并发更新仍可能在保存时覆盖他端，完整解决需乐观并发锁。
 */
export function shouldAdoptServerShortcuts(
  server: ShortcutDraftSnapshot,
  baseline: ShortcutDraftSnapshot | null,
  draft: ShortcutDraftSnapshot
): boolean {
  if (!baseline) return true;
  if (!isShortcutDraftDirty(server, baseline)) return false;
  return !isShortcutDraftDirty(draft, baseline);
}

export function reorderShortcuts(
  items: TerminalShortcutItem[],
  activeId: string,
  overId: string
): TerminalShortcutItem[] {
  const from = items.findIndex((item) => item.id === activeId);
  const to = items.findIndex((item) => item.id === overId);
  if (from < 0 || to < 0 || from === to) return items;
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function removeShortcut(items: TerminalShortcutItem[], id: string): TerminalShortcutItem[] {
  return items.filter((item) => item.id !== id);
}

export function setShortcutLabel(
  items: TerminalShortcutItem[],
  id: string,
  label: string
): TerminalShortcutItem[] {
  return items.map((item) => (item.id === id ? { ...item, label } : item));
}

export function setShortcutPayload(
  items: TerminalShortcutItem[],
  id: string,
  payload: string
): TerminalShortcutItem[] {
  return items.map((item) => (item.id === id ? { ...item, payload } : item));
}

/** payload 为空视为无效录入，直接返回原列表；label 缺省回退到 payload。 */
export function appendSendShortcut(
  items: TerminalShortcutItem[],
  label: string,
  payload: string,
  id: string
): TerminalShortcutItem[] {
  if (!payload) return items;
  return [...items, { id, type: 'send', label: label || payload, payload }];
}

export function appendActionShortcut(
  items: TerminalShortcutItem[],
  action: TerminalShortcutAction,
  id: string
): TerminalShortcutItem[] {
  return [...items, { id, type: 'action', action, label: '' }];
}

export function defaultShortcutDraft(): ShortcutDraftSnapshot {
  return { items: DEFAULT_TERMINAL_SHORTCUTS.map((item) => ({ ...item })), useIcons: false };
}

export interface TerminalShortcutsEditorProps {
  /** 注入自定义读取；缺省读当前 runtime 指向的 gateway。 */
  loadShortcuts?: () => Promise<TerminalShortcutSettings>;
  /**
   * 注入自定义保存；可返回保存后的权威值（缺省或返回空时以提交的草稿为基线）。
   * 缺省写当前 runtime 指向的 gateway。
   */
  saveShortcuts?: (
    updates: UpdateTerminalShortcutSettingsRequest
  ) => Promise<TerminalShortcutSettings | undefined> | Promise<void>;
  /** 缓存 key；注入自定义存取时建议同时传独立 key，避免与缺省 gateway 缓存互串。 */
  queryKey?: readonly unknown[];
}

export interface ShortcutAddFormModel {
  capturing: boolean;
  setCapturing: (capturing: boolean) => void;
  onCaptureKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  advancedOpen: boolean;
  toggleAdvanced: () => void;
  manualLabel: string;
  setManualLabel: (label: string) => void;
  manualPayload: string;
  setManualPayload: (payload: string) => void;
  addManual: () => void;
}

export interface TerminalShortcutsEditorModel {
  /** 基线已建立（首次数据到手）；错误/加载占位只在未就绪时展示。 */
  ready: boolean;
  isLoading: boolean;
  isError: boolean;
  retry: () => void;
  items: TerminalShortcutItem[];
  useIcons: boolean;
  setUseIcons: (useIcons: boolean) => void;
  dirty: boolean;
  isSaving: boolean;
  save: () => void;
  reset: () => void;
  updateLabel: (id: string, label: string) => void;
  updatePayload: (id: string, payload: string) => void;
  removeItem: (id: string) => void;
  reorder: (activeId: string, overId: string) => void;
  addAction: (action: TerminalShortcutAction) => void;
  addForm: ShortcutAddFormModel;
}

interface ShortcutDraftState extends ShortcutDraftSnapshot {
  setItems: (updater: (prev: TerminalShortcutItem[]) => TerminalShortcutItem[]) => void;
  setUseIcons: (useIcons: boolean) => void;
  baseline: ShortcutDraftSnapshot | null;
  dirty: boolean;
  adopt: (next: ShortcutDraftSnapshot) => void;
}

function useShortcutDraft(data: TerminalShortcutSettings | undefined): ShortcutDraftState {
  const [items, setItems] = useState<TerminalShortcutItem[]>([]);
  const [useIcons, setUseIcons] = useState(false);
  const [baseline, setBaseline] = useState<ShortcutDraftSnapshot | null>(null);

  const adopt = useCallback((next: ShortcutDraftSnapshot) => {
    setItems(next.items);
    setUseIcons(next.useIcons);
    setBaseline({ items: next.items, useIcons: next.useIcons });
  }, []);

  // 初始化，以及当用户未编辑时跟随服务器最新值（其它端保存触发的后台 refetch）。
  useEffect(() => {
    if (!data) return;
    const server: ShortcutDraftSnapshot = { items: data.items, useIcons: data.useIcons };
    if (shouldAdoptServerShortcuts(server, baseline, { items, useIcons })) {
      adopt(server);
    }
  }, [data, baseline, items, useIcons, adopt]);

  const dirty = useMemo(
    () => isShortcutDraftDirty({ items, useIcons }, baseline),
    [items, useIcons, baseline]
  );

  return { items, setItems, useIcons, setUseIcons, baseline, dirty, adopt };
}

interface SaveMutationParams {
  draft: ShortcutDraftSnapshot;
  adopt: (next: ShortcutDraftSnapshot) => void;
  apiClient: ApiClient;
  shortcutsQueryKey: readonly unknown[];
  saveShortcuts?: TerminalShortcutsEditorProps['saveShortcuts'];
}

function useShortcutSaveMutation({
  draft,
  adopt,
  apiClient,
  shortcutsQueryKey,
  saveShortcuts,
}: SaveMutationParams) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<TerminalShortcutSettings> => {
      const updates: UpdateTerminalShortcutSettingsRequest = {
        items: draft.items,
        useIcons: draft.useIcons,
      };
      if (!saveShortcuts) return updateTerminalShortcuts(updates, apiClient);
      const saved = (await saveShortcuts(updates)) as TerminalShortcutSettings | undefined;
      return saved ?? { ...updates, updatedAt: new Date().toISOString() };
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(shortcutsQueryKey, saved);
      adopt({ items: saved.items, useIcons: saved.useIcons });
      toast.success(t('settings.terminal.shortcuts.saved'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('settings.terminal.shortcuts.saveFailed'));
    },
  });
}

function useShortcutAddForm(
  addSend: (label: string, payload: string) => void
): ShortcutAddFormModel {
  const [capturing, setCapturing] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [manualLabel, setManualLabel] = useState('');
  const [manualPayload, setManualPayload] = useState('');

  const onCaptureKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const seq = keyEventToTerminalSequence({
      key: event.key,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
    });
    if (!seq) return;
    addSend(seq.label, seq.payload);
    setCapturing(false);
  };

  const addManual = () => {
    const payload = parseEscapeSequence(manualPayload);
    if (!payload) return;
    addSend(manualLabel.trim(), payload);
    setManualLabel('');
    setManualPayload('');
  };

  return {
    capturing,
    setCapturing,
    onCaptureKeyDown,
    advancedOpen,
    toggleAdvanced: () => setAdvancedOpen((open) => !open),
    manualLabel,
    setManualLabel,
    manualPayload,
    setManualPayload,
    addManual,
  };
}

export function useTerminalShortcutsEditor({
  loadShortcuts,
  saveShortcuts,
  queryKey,
}: TerminalShortcutsEditorProps = {}): TerminalShortcutsEditorModel {
  const { apiClient } = useRuntime();
  const shortcutsQueryKey = queryKey ?? terminalShortcutsQueryKey;
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: shortcutsQueryKey,
    queryFn: () => (loadShortcuts ? loadShortcuts() : fetchTerminalShortcuts(apiClient)),
  });

  const { items, setItems, useIcons, setUseIcons, baseline, dirty, adopt } = useShortcutDraft(data);
  const mutation = useShortcutSaveMutation({
    draft: { items, useIcons },
    adopt,
    apiClient,
    shortcutsQueryKey,
    saveShortcuts,
  });

  const addSend = useCallback(
    (label: string, payload: string) =>
      setItems((prev) => appendSendShortcut(prev, label, payload, newShortcutId())),
    [setItems]
  );
  const addForm = useShortcutAddForm(addSend);

  return {
    ready: baseline !== null,
    isLoading,
    isError,
    retry: () => {
      void refetch();
    },
    items,
    useIcons,
    setUseIcons,
    dirty,
    isSaving: mutation.isPending,
    save: () => mutation.mutate(),
    reset: () => {
      const next = defaultShortcutDraft();
      setItems(() => next.items);
      setUseIcons(next.useIcons);
    },
    updateLabel: (id, label) => setItems((prev) => setShortcutLabel(prev, id, label)),
    updatePayload: (id, payload) => setItems((prev) => setShortcutPayload(prev, id, payload)),
    removeItem: (id) => setItems((prev) => removeShortcut(prev, id)),
    reorder: (activeId, overId) => setItems((prev) => reorderShortcuts(prev, activeId, overId)),
    addAction: (action) => setItems((prev) => appendActionShortcut(prev, action, newShortcutId())),
    addForm,
  };
}
