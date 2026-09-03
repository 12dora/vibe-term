// editor 输入模式面板：移动端在编辑器上方额外挂快捷键栏，其余为文本域 + 发送/清空动作。
// DOM 结构与 data-testid 被 e2e 依赖，改动需同步 apps/fe/tests。

import type { TerminalShortcutItem } from '@tmex/shared';
import { useUIStore } from '@tmex/stores/react';
import { Button } from '@tmex/ui/button';
import { Switch } from '@tmex/ui/switch';
import { Loader2, Send, Trash2 } from 'lucide-react';
import { type KeyboardEvent, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ShortcutsBar } from './terminal-shortcuts-slot';
import type { EditorInput } from './use-editor-input';

function SendIcon({ isSending }: { isSending: boolean }) {
  return isSending ? (
    <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
  ) : (
    <Send className="h-4 w-4" />
  );
}

export interface EditorInputPanelProps {
  editor: EditorInput;
  isMobile: boolean;
  canInteractWithPane: boolean;
  onActivateShortcut: (item: TerminalShortcutItem) => void;
  /** Esc 收起命令输入框，回到直接输入 */
  onClose: () => void;
}

export function EditorInputPanel({
  editor,
  isMobile,
  canInteractWithPane,
  onActivateShortcut,
  onClose,
}: EditorInputPanelProps) {
  const { t } = useTranslation();
  const editorSendWithEnter = useUIStore((state) => state.editorSendWithEnter);
  const setEditorSendWithEnter = useUIStore((state) => state.setEditorSendWithEnter);
  const { editorText, editorTextareaRef, isSending, focusEditor } = editor;
  const sendDisabled = !canInteractWithPane || isSending;

  // 面板由顶栏图标展开，焦点直接落到输入框，省一次点击
  useEffect(() => {
    focusEditor();
  }, [focusEditor]);

  // Esc 收起；输入法候选窗开着时的 Esc 归输入法，不能顺手把面板关了
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    onClose();
  };

  return (
    <div
      data-virtual-keyboard-avoid
      onKeyDown={handleKeyDown}
      className="editor-mode-input bg-card"
    >
      {/* 移动端 editor 模式：快捷键栏在编辑器上方 */}
      {isMobile && (
        <ShortcutsBar
          onActivate={(item) => {
            onActivateShortcut(item);
            if (item.type === 'send') {
              editor.focusEditor();
            }
          }}
          disabled={!canInteractWithPane}
        />
      )}
      <textarea
        ref={editorTextareaRef}
        data-testid="editor-input"
        className="min-h-[88px] max-h-[28vh] w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground shadow-xs outline-none transition-colors duration-(--tmex-motion-fast) ease-out focus:border-ring motion-reduce:transition-none"
        value={editorText}
        onChange={(e) => editor.handleEditorChange(e.target.value)}
        placeholder={t('terminal.inputPlaceholder')}
      />
      <div className="actions mt-2">
        <div
          className="send-row flex flex-wrap items-center justify-end gap-2"
          data-testid="editor-send-row"
        >
          <div
            className="send-with-enter-toggle mr-auto flex items-center gap-2 text-xs text-muted-foreground"
            data-testid="editor-send-with-enter-toggle"
          >
            <Switch
              size="sm"
              checked={editorSendWithEnter}
              onCheckedChange={(checked) => setEditorSendWithEnter(Boolean(checked))}
            />
            <span>{t('terminal.editorSendWithEnter')}</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            data-testid="editor-clear"
            onMouseDown={(e) => e.preventDefault()}
            onClick={editor.handleEditorClear}
            title={t('terminal.clear')}
          >
            <Trash2 className="h-4 w-4" />
            {t('terminal.clear')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            data-testid="editor-send-line-by-line"
            onMouseDown={(e) => e.preventDefault()}
            onClick={editor.handleEditorSendLineByLine}
            disabled={sendDisabled}
          >
            <SendIcon isSending={isSending} />
            {t('terminal.editorSendLineByLine')}
          </Button>
          <Button
            variant="default"
            size="sm"
            data-testid="editor-send"
            onMouseDown={(e) => e.preventDefault()}
            onClick={editor.handleEditorSend}
            disabled={sendDisabled}
          >
            <SendIcon isSending={isSending} />
            {t('common.send')}
          </Button>
        </div>
      </div>
    </div>
  );
}
