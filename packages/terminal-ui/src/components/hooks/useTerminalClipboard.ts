import { useRuntime, useUIStore } from '@vibeterm/stores/react';
import type { CompatibleTerminalLike } from 'ghostty-terminal';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { refocusTerminalInput } from '../../utils/terminal-input-focus';
import { nextAutoCopyText, planCopySelection } from '../selection-copy';

export interface UseTerminalClipboardOptions {
  instance: CompatibleTerminalLike | null;
}

export interface TerminalClipboard {
  /** 当前是否有选区（选区工具条的可见性） */
  hasSelection: boolean;
  /** auto 模式下工具条不展示复制按钮 */
  showCopyButton: boolean;
  copySelection: () => void;
  pasteClipboard: () => void;
  dismissSelection: () => void;
  commitSelectionCopy: () => void;
}

/** 终端剪贴板面：选区状态跟踪与复制/粘贴/取消三个工具条动作。 */
export function useTerminalClipboard({ instance }: UseTerminalClipboardOptions): TerminalClipboard {
  const [hasSelection, setHasSelection] = useState(false);
  const runtime = useRuntime();
  const { t } = useTranslation();
  const copyMode = useUIStore((state) => state.terminalCopyMode);
  const lastCopiedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!instance?.onSelectionChange) {
      setHasSelection(false);
      lastCopiedRef.current = null;
      return;
    }

    const disposable = instance.onSelectionChange((text) => {
      setHasSelection(Boolean(text));
      if (!text) {
        lastCopiedRef.current = null;
      }
    });

    return () => {
      disposable.dispose();
      setHasSelection(false);
      lastCopiedRef.current = null;
    };
  }, [instance]);

  const writeSelection = useCallback(
    (text: string, clearAfter: boolean) => {
      void runtime.host
        .writeClipboardText(text)
        .then(() => {
          runtime.notifications.success(t('terminal.copied'));
        })
        .catch(() => {
          runtime.notifications.error(t('terminal.copyFailed'));
          lastCopiedRef.current = null;
        })
        .finally(() => {
          if (clearAfter) {
            instance?.clearSelection?.();
            refocusTerminalInput(instance);
          }
        });
    },
    [instance, runtime, t]
  );

  const copySelection = useCallback(() => {
    if (!instance) return;
    const text = instance.getSelection?.() ?? '';
    if (planCopySelection(text) === 'empty') {
      runtime.notifications.error(t('terminal.copyFailed'));
      return;
    }

    writeSelection(text, true);
  }, [instance, runtime, t, writeSelection]);

  const commitSelectionCopy = useCallback(() => {
    if (!instance || copyMode !== 'auto') return;
    const text = instance.getSelection?.() ?? '';
    const next = nextAutoCopyText(text, lastCopiedRef.current);
    if (!next) return;
    lastCopiedRef.current = next;
    writeSelection(next, false);
  }, [copyMode, instance, writeSelection]);

  const pasteClipboard = useCallback(() => {
    if (!instance) return;

    void runtime.host
      .readClipboardText()
      .then((text) => {
        if (text) {
          instance.paste(text);
        }
        instance.clearSelection?.();
        refocusTerminalInput(instance);
      })
      .catch(() => {
        runtime.notifications.error(t('terminal.pasteFailed'));
      });
  }, [instance, runtime, t]);

  const dismissSelection = useCallback(() => {
    instance?.clearSelection?.();
    refocusTerminalInput(instance);
  }, [instance]);

  return {
    hasSelection,
    showCopyButton: copyMode !== 'auto',
    copySelection,
    pasteClipboard,
    dismissSelection,
    commitSelectionCopy,
  };
}
