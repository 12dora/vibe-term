import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import type { TerminalShortcutSettings, UpdateTerminalShortcutSettingsRequest } from '@tmex/shared';
import { Button } from '@tmex/ui/button';
import { Switch } from '@tmex/ui/switch';
import { RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ShortcutButtonRow } from './ShortcutButtonRow';
import { TerminalShortcutAddPanel } from './terminal-shortcut-add-panel';
import { SortableShortcutRow } from './terminal-shortcut-row';
import { useTerminalShortcutsEditor } from './use-terminal-shortcuts-editor';

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

/**
 * 终端快捷键编辑器：草稿态编辑 + 拖拽排序 + 三入口录入 + 图标开关 + 实时预览，
 * 显式「保存」写入服务器（保存后经 react-query 失效让终端栏即时刷新）。
 * 存取可经 props 注入（嵌入自带存储的宿主时复用），缺省走本 gateway API。
 */
export function TerminalShortcutsEditor({
  loadShortcuts,
  saveShortcuts,
  queryKey,
}: TerminalShortcutsEditorProps = {}) {
  const { t } = useTranslation();
  const editor = useTerminalShortcutsEditor({ loadShortcuts, saveShortcuts, queryKey });

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  if (editor.loadFailed) {
    return (
      <div className="space-y-2" data-testid="terminal-shortcuts-error">
        <p className="text-destructive text-sm">{t('settings.terminal.shortcuts.loadFailed')}</p>
        <Button type="button" variant="outline" size="sm" onClick={editor.refetch}>
          {t('settings.terminal.shortcuts.retry')}
        </Button>
      </div>
    );
  }
  if (editor.loadingInitial) {
    return (
      <p className="text-muted-foreground text-sm">{t('settings.terminal.shortcuts.loading')}</p>
    );
  }

  return (
    <div className="space-y-5" data-testid="terminal-shortcuts-editor">
      {/* 实时预览 */}
      <div className="space-y-2">
        <span className="block font-medium text-sm">
          {t('settings.terminal.shortcuts.preview')}
        </span>
        <div
          className="rounded-lg border border-border bg-muted/30 px-3"
          data-testid="shortcut-preview"
        >
          <ShortcutButtonRow items={editor.items} useIcons={editor.useIcons} />
        </div>
      </div>

      {/* 图标开关（对齐设置项行：边框盒子 + 左标签右开关） */}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium text-sm">{t('settings.terminal.shortcuts.useIcons')}</span>
          <span className="text-muted-foreground text-xs">
            {t('settings.terminal.shortcuts.useIconsDesc')}
          </span>
        </span>
        <Switch
          checked={editor.useIcons}
          onCheckedChange={(checked) => editor.setUseIcons(checked)}
          aria-label={t('settings.terminal.shortcuts.useIcons')}
          data-testid="shortcut-use-icons"
        />
      </div>

      {/* 可拖拽列表 */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={editor.handleDragEnd}
      >
        <SortableContext
          items={editor.items.map((i) => i.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-2" data-testid="shortcut-editor-list">
            {editor.items.map((item) => (
              <SortableShortcutRow
                key={item.id}
                item={item}
                onLabelChange={editor.updateLabel}
                onPayloadChange={editor.updatePayload}
                onRemove={editor.removeItem}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <TerminalShortcutAddPanel onAddSend={editor.addSend} onAddAction={editor.addAction} />

      {/* 保存 / 重置 */}
      <div className="flex items-center justify-between gap-2 pt-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={editor.handleReset}
          data-testid="shortcut-reset"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t('settings.terminal.shortcuts.reset')}
        </Button>
        <Button
          type="button"
          variant="default"
          size="default"
          onClick={editor.save}
          disabled={!editor.dirty || editor.isSaving}
          data-testid="shortcut-save"
        >
          {t('settings.terminal.shortcuts.save')}
        </Button>
      </div>
    </div>
  );
}
