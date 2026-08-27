import { Button } from '@tmex/ui/button';
import { RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ShortcutAddPanel } from './shortcut-add-panel';
import { ShortcutList } from './shortcut-list';
import { ShortcutIconsToggle, ShortcutPreview } from './shortcut-preview';
import {
  type TerminalShortcutsEditorModel,
  type TerminalShortcutsEditorProps,
  useTerminalShortcutsEditor,
} from './use-terminal-shortcuts-editor';

export type { TerminalShortcutsEditorProps };

function ShortcutsLoadError({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2" data-testid="terminal-shortcuts-error">
      <p className="text-destructive text-sm">{t('settings.terminal.shortcuts.loadFailed')}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        {t('settings.terminal.shortcuts.retry')}
      </Button>
    </div>
  );
}

function ShortcutsFooter({ model }: { model: TerminalShortcutsEditorModel }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-2 pt-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={model.reset}
        data-testid="shortcut-reset"
      >
        <RotateCcw className="h-3.5 w-3.5" />
        {t('settings.terminal.shortcuts.reset')}
      </Button>
      <Button
        type="button"
        variant="default"
        size="default"
        onClick={model.save}
        disabled={!model.dirty || model.isSaving}
        data-testid="shortcut-save"
      >
        {t('settings.terminal.shortcuts.save')}
      </Button>
    </div>
  );
}

/**
 * 终端快捷键编辑器：草稿态编辑 + 拖拽排序 + 三入口录入 + 图标开关 + 实时预览，
 * 显式「保存」写入服务器（保存后经 react-query 失效让终端栏即时刷新）。
 * 存取可经 props 注入（嵌入自带存储的宿主时复用），缺省走本 gateway API。
 */
export function TerminalShortcutsEditor(props: TerminalShortcutsEditorProps = {}) {
  const { t } = useTranslation();
  const model = useTerminalShortcutsEditor(props);

  if (model.isError && !model.ready) {
    return <ShortcutsLoadError onRetry={model.retry} />;
  }
  if (model.isLoading && !model.ready) {
    return (
      <p className="text-muted-foreground text-sm">{t('settings.terminal.shortcuts.loading')}</p>
    );
  }

  return (
    <div className="space-y-5" data-testid="terminal-shortcuts-editor">
      <ShortcutPreview items={model.items} useIcons={model.useIcons} />
      <ShortcutIconsToggle useIcons={model.useIcons} onChange={model.setUseIcons} />
      <ShortcutList
        items={model.items}
        onLabelChange={model.updateLabel}
        onPayloadChange={model.updatePayload}
        onRemove={model.removeItem}
        onReorder={model.reorder}
      />
      <ShortcutAddPanel form={model.addForm} onAddAction={model.addAction} />
      <ShortcutsFooter model={model} />
    </div>
  );
}
