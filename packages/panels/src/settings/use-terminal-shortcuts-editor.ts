import type { DragEndEvent } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
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
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { createActionItem, createSendItem, sameItems } from './terminal-shortcuts-model';

export interface UseTerminalShortcutsEditorOptions {
  loadShortcuts?: () => Promise<TerminalShortcutSettings>;
  saveShortcuts?: (
    updates: UpdateTerminalShortcutSettingsRequest
  ) => Promise<TerminalShortcutSettings | undefined> | Promise<void>;
  queryKey?: readonly unknown[];
}

export interface TerminalShortcutsEditorModel {
  items: TerminalShortcutItem[];
  useIcons: boolean;
  dirty: boolean;
  isSaving: boolean;
  loadFailed: boolean;
  loadingInitial: boolean;
  refetch: () => void;
  setUseIcons: (useIcons: boolean) => void;
  handleDragEnd: (event: DragEndEvent) => void;
  updateLabel: (id: string, label: string) => void;
  updatePayload: (id: string, payload: string) => void;
  removeItem: (id: string) => void;
  addSend: (label: string, payload: string) => void;
  addAction: (action: TerminalShortcutAction) => void;
  handleReset: () => void;
  save: () => void;
}

export function useTerminalShortcutsEditor({
  loadShortcuts,
  saveShortcuts,
  queryKey,
}: UseTerminalShortcutsEditorOptions): TerminalShortcutsEditorModel {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { apiClient } = useRuntime();
  const shortcutsQueryKey = queryKey ?? terminalShortcutsQueryKey;
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: shortcutsQueryKey,
    queryFn: () => (loadShortcuts ? loadShortcuts() : fetchTerminalShortcuts(apiClient)),
  });

  const [items, setItems] = useState<TerminalShortcutItem[]>([]);
  const [useIcons, setUseIcons] = useState(false);
  // 与服务器对齐的基线快照（null=未初始化）；dirty 与外部更新跟随都基于它
  const [baseline, setBaseline] = useState<{
    items: TerminalShortcutItem[];
    useIcons: boolean;
  } | null>(null);

  // 初始化，以及当用户未编辑时跟随服务器最新值（其它端保存触发的后台 refetch），
  // 既消除假 dirty、也避免用陈旧草稿盲覆盖他端更新。
  // 注意：用户正在编辑（dirty）时发生的并发更新仍可能在保存时覆盖他端，完整解决需乐观并发锁。
  useEffect(() => {
    if (!data) return;
    if (baseline === null) {
      setItems(data.items);
      setUseIcons(data.useIcons);
      setBaseline({ items: data.items, useIcons: data.useIcons });
      return;
    }
    if (sameItems(baseline.items, data.items) && baseline.useIcons === data.useIcons) {
      return; // baseline 已与服务器一致，无需动作（避免循环）
    }
    const pristine = sameItems(items, baseline.items) && useIcons === baseline.useIcons;
    if (pristine) {
      setItems(data.items);
      setUseIcons(data.useIcons);
      setBaseline({ items: data.items, useIcons: data.useIcons });
    }
  }, [data, baseline, items, useIcons]);

  const dirty = useMemo(() => {
    if (!baseline) return false;
    return !sameItems(items, baseline.items) || useIcons !== baseline.useIcons;
  }, [items, useIcons, baseline]);

  const mutation = useMutation({
    mutationFn: async (): Promise<TerminalShortcutSettings> => {
      const updates: UpdateTerminalShortcutSettingsRequest = { items, useIcons };
      if (saveShortcuts) {
        const saved = (await saveShortcuts(updates)) as TerminalShortcutSettings | undefined;
        return saved ?? { ...updates, updatedAt: new Date().toISOString() };
      }
      return updateTerminalShortcuts(updates, apiClient);
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(shortcutsQueryKey, saved);
      setItems(saved.items);
      setUseIcons(saved.useIcons);
      setBaseline({ items: saved.items, useIcons: saved.useIcons });
      toast.success(t('settings.terminal.shortcuts.saved'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('settings.terminal.shortcuts.saveFailed'));
    },
  });

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setItems((prev) => {
      const oldIndex = prev.findIndex((i) => i.id === active.id);
      const newIndex = prev.findIndex((i) => i.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  };

  const addSend = (label: string, payload: string) => {
    if (!payload) return;
    setItems((prev) => [...prev, createSendItem(label, payload)]);
  };

  return {
    items,
    useIcons,
    dirty,
    isSaving: mutation.isPending,
    loadFailed: isError && !baseline,
    loadingInitial: isLoading && !baseline,
    refetch: () => void refetch(),
    setUseIcons,
    handleDragEnd,
    updateLabel: (id, label) =>
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, label } : i))),
    updatePayload: (id, payload) =>
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, payload } : i))),
    removeItem: (id) => setItems((prev) => prev.filter((i) => i.id !== id)),
    addSend,
    addAction: (action) => setItems((prev) => [...prev, createActionItem(action)]),
    handleReset: () => {
      setItems(DEFAULT_TERMINAL_SHORTCUTS.map((i) => ({ ...i })));
      setUseIcons(false);
    },
    save: () => mutation.mutate(),
  };
}
