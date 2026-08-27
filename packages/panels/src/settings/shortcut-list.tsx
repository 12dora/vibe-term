import {
  DndContext,
  type DragEndEvent,
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
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { TerminalShortcutAction, TerminalShortcutItem } from '@tmex/shared';
import { escapeForDisplay, parseEscapeSequence } from '@tmex/terminal-ui';
import { cn } from '@tmex/ui';
import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { GripVertical, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { actionIcon } from './shortcut-action-meta';

interface ShortcutRowHandlers {
  onLabelChange: (id: string, label: string) => void;
  onPayloadChange: (id: string, payload: string) => void;
  onRemove: (id: string) => void;
}

export interface ShortcutListProps extends ShortcutRowHandlers {
  items: TerminalShortcutItem[];
  onReorder: (activeId: string, overId: string) => void;
}

function ActionBadge({ action }: { action: TerminalShortcutAction }) {
  const { t } = useTranslation();
  const Icon = actionIcon(action);
  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
      <Icon className="h-3.5 w-3.5" />
      {t(`settings.terminal.shortcuts.action.${action}`)}
    </span>
  );
}

function ActionRowFields({
  item,
  action,
  onLabelChange,
}: {
  item: TerminalShortcutItem;
  action: TerminalShortcutAction;
  onLabelChange: (id: string, label: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <ActionBadge action={action} />
      <Input
        value={item.label}
        onChange={(e) => onLabelChange(item.id, e.target.value)}
        placeholder={t(`settings.terminal.shortcuts.action.${action}`)}
        className="h-9 min-w-0 flex-1"
        data-testid={`shortcut-editor-label-${item.id}`}
      />
    </div>
  );
}

function SendRowFields({
  item,
  onLabelChange,
  onPayloadChange,
}: {
  item: TerminalShortcutItem;
  onLabelChange: (id: string, label: string) => void;
  onPayloadChange: (id: string, payload: string) => void;
}) {
  const { t } = useTranslation();
  // payload 行内编辑用本地草稿（展示转义串），失焦时解析回原始序列，避免每次输入抖动
  const [payloadDraft, setPayloadDraft] = useState(() => escapeForDisplay(item.payload ?? ''));
  useEffect(() => {
    setPayloadDraft(escapeForDisplay(item.payload ?? ''));
  }, [item.payload]);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <Input
        value={item.label}
        onChange={(e) => onLabelChange(item.id, e.target.value)}
        placeholder={t('settings.terminal.shortcuts.labelPlaceholder')}
        className="h-9 w-24 font-mono"
        data-testid={`shortcut-editor-label-${item.id}`}
      />
      <Input
        value={payloadDraft}
        onChange={(e) => setPayloadDraft(e.target.value)}
        onBlur={() => onPayloadChange(item.id, parseEscapeSequence(payloadDraft))}
        placeholder={t('settings.terminal.shortcuts.payloadPlaceholder')}
        spellCheck={false}
        className="h-9 min-w-0 flex-1 font-mono text-xs"
        data-testid={`shortcut-editor-payload-${item.id}`}
      />
    </div>
  );
}

function SortableShortcutRow({
  item,
  onLabelChange,
  onPayloadChange,
  onRemove,
}: ShortcutRowHandlers & { item: TerminalShortcutItem }) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });
  const action = item.type === 'action' ? item.action : undefined;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        'flex items-center gap-2 rounded-lg border border-border bg-background p-2.5',
        isDragging && 'opacity-60 shadow-sm'
      )}
      data-testid={`shortcut-editor-row-${item.id}`}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={t('settings.terminal.shortcuts.dragHandle')}
        className="shrink-0 cursor-grab touch-none text-muted-foreground hover:text-foreground"
      >
        <GripVertical className="h-4 w-4" />
      </button>

      {action ? (
        <ActionRowFields item={item} action={action} onLabelChange={onLabelChange} />
      ) : (
        <SendRowFields
          item={item}
          onLabelChange={onLabelChange}
          onPayloadChange={onPayloadChange}
        />
      )}

      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => onRemove(item.id)}
        aria-label={t('settings.terminal.shortcuts.delete')}
        data-testid={`shortcut-editor-remove-${item.id}`}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

/** 可拖拽的快捷键列表；排序结果经 onReorder 交回数据层。 */
export function ShortcutList({ items, onReorder, ...handlers }: ShortcutListProps) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    onReorder(String(active.id), String(over.id));
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        <div className="space-y-2" data-testid="shortcut-editor-list">
          {items.map((item) => (
            <SortableShortcutRow key={item.id} item={item} {...handlers} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
