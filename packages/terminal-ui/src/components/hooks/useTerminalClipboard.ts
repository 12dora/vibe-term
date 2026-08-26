import { useRuntime } from '@tmex/stores/react';
import type { CompatibleTerminalLike } from 'ghostty-terminal';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface UseTerminalClipboardOptions {
  instance: CompatibleTerminalLike | null;
}

export interface TerminalClipboard {
  /** 当前是否有选区（选区工具条的可见性） */
  hasSelection: boolean;
  copySelection: () => void;
  pasteClipboard: () => void;
  dismissSelection: () => void;
}

/** 终端剪贴板面：选区状态跟踪与复制/粘贴/取消三个工具条动作。 */
export function useTerminalClipboard({ instance }: UseTerminalClipboardOptions): TerminalClipboard {
  const [hasSelection, setHasSelection] = useState(false);
  const runtime = useRuntime();
  const { t } = useTranslation();

  useEffect(() => {
    if (!instance?.onSelectionChange) {
      setHasSelection(false);
      return;
    }

    const disposable = instance.onSelectionChange((text) => {
      setHasSelection(Boolean(text));
    });

    return () => {
      disposable.dispose();
      setHasSelection(false);
    };
  }, [instance]);

  const copySelection = useCallback(() => {
    if (!instance) return;
    const text = instance.getSelection?.() ?? '';
    if (!text) return;

    void runtime.host
      .writeClipboardText(text)
      .then(() => {
        runtime.notifications.success(t('terminal.copied'));
      })
      .catch(() => {
        runtime.notifications.error(t('terminal.copyFailed'));
      })
      .finally(() => {
        instance.clearSelection?.();
        instance.focus();
      });
  }, [instance, runtime, t]);

  const pasteClipboard = useCallback(() => {
    if (!instance) return;

    void runtime.host
      .readClipboardText()
      .then((text) => {
        if (text) {
          instance.paste(text);
        }
        instance.clearSelection?.();
        instance.focus();
      })
      .catch(() => {
        runtime.notifications.error(t('terminal.pasteFailed'));
      });
  }, [instance, runtime, t]);

  const dismissSelection = useCallback(() => {
    instance?.clearSelection?.();
    instance?.focus();
  }, [instance]);

  return { hasSelection, copySelection, pasteClipboard, dismissSelection };
}
