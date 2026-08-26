// editor 输入模式：草稿持久化、整段/逐行发送、历史与发送反馈。
// 两种发送只在 payload 切分上不同，其余（守卫、发送反馈、历史、清草稿、清空）共用一条路径。

import { useRuntime, useUIStore } from '@tmex/stores/react';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

const SEND_FEEDBACK_MS = 150;

export type EditorSendMode = 'whole' | 'line-by-line';

/** 整段发送按开关决定是否补回车；逐行发送逐条补回车并跳过空行。 */
export function buildEditorPayloads(
  text: string,
  mode: EditorSendMode,
  sendWithEnter: boolean
): string[] {
  if (mode === 'line-by-line') {
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => `${line}\r`);
  }
  return [sendWithEnter ? `${text}\r` : text];
}

export interface UseEditorInputOptions {
  deviceId?: string;
  paneId?: string;
  /** `${deviceId}:${paneId}`，无有效 pane 时为 null（不落草稿） */
  draftKey: string | null;
  canInteractWithPane: boolean;
  isMobile: boolean;
}

export interface EditorInput {
  editorText: string;
  editorTextareaRef: RefObject<HTMLTextAreaElement | null>;
  isSending: boolean;
  focusEditor: () => void;
  handleEditorChange: (nextText: string) => void;
  handleEditorSend: () => void;
  handleEditorSendLineByLine: () => void;
  handleEditorClear: () => void;
}

export function useEditorInput({
  deviceId,
  paneId,
  draftKey,
  canInteractWithPane,
  isMobile,
}: UseEditorInputOptions): EditorInput {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const editorTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const sendFeedbackTimerRef = useRef<number | null>(null);
  const [editorText, setEditorText] = useState('');
  const [isSending, setIsSending] = useState(false);

  const inputMode = useUIStore((state) => state.inputMode);
  const editorSendWithEnter = useUIStore((state) => state.editorSendWithEnter);
  const addEditorHistory = useUIStore((state) => state.addEditorHistory);
  const setEditorDraft = useUIStore((state) => state.setEditorDraft);
  const removeEditorDraft = useUIStore((state) => state.removeEditorDraft);
  const paneEditorDraft = useUIStore((state) =>
    draftKey ? (state.editorDrafts[draftKey] ?? '') : ''
  );

  useEffect(() => {
    setEditorText(paneEditorDraft);
  }, [paneEditorDraft]);

  useEffect(
    () => () => {
      if (sendFeedbackTimerRef.current !== null) {
        window.clearTimeout(sendFeedbackTimerRef.current);
      }
    },
    []
  );

  const focusEditor = useCallback(() => {
    editorTextareaRef.current?.focus({ preventScroll: true });
  }, []);

  // 移动端 editor 模式下按钮点击会抢焦点，动作完成后把焦点还给输入框
  const refocusOnMobile = useCallback(() => {
    if (isMobile && inputMode === 'editor') {
      focusEditor();
    }
  }, [focusEditor, inputMode, isMobile]);

  const clearDraft = useCallback(() => {
    if (draftKey) {
      removeEditorDraft(draftKey);
    }
  }, [draftKey, removeEditorDraft]);

  const sendEditorText = useCallback(
    (mode: EditorSendMode) => {
      if (!canInteractWithPane) {
        toast.error(t('wsError.checkGateway'));
        return;
      }
      if (!deviceId || !paneId) return;
      if (!editorText.trim()) return;

      setIsSending(true);
      if (sendFeedbackTimerRef.current !== null) {
        window.clearTimeout(sendFeedbackTimerRef.current);
      }
      sendFeedbackTimerRef.current = window.setTimeout(() => {
        sendFeedbackTimerRef.current = null;
        setIsSending(false);
      }, SEND_FEEDBACK_MS);

      const store = runtime.stores.tmux.getState();
      for (const payload of buildEditorPayloads(editorText, mode, editorSendWithEnter)) {
        store.sendInput(deviceId, paneId, payload, false);
      }

      addEditorHistory(editorText);
      clearDraft();
      setEditorText('');
    },
    [
      addEditorHistory,
      canInteractWithPane,
      clearDraft,
      deviceId,
      editorSendWithEnter,
      editorText,
      paneId,
      runtime,
      t,
    ]
  );

  const handleEditorSend = useCallback(() => {
    sendEditorText('whole');
    refocusOnMobile();
  }, [refocusOnMobile, sendEditorText]);

  const handleEditorSendLineByLine = useCallback(() => {
    sendEditorText('line-by-line');
    refocusOnMobile();
  }, [refocusOnMobile, sendEditorText]);

  const handleEditorClear = useCallback(() => {
    setEditorText('');
    clearDraft();
    refocusOnMobile();
  }, [clearDraft, refocusOnMobile]);

  const handleEditorChange = useCallback(
    (nextText: string) => {
      setEditorText(nextText);
      if (!draftKey) {
        return;
      }
      if (nextText) {
        setEditorDraft(draftKey, nextText);
        return;
      }
      removeEditorDraft(draftKey);
    },
    [draftKey, removeEditorDraft, setEditorDraft]
  );

  return {
    editorText,
    editorTextareaRef,
    isSending,
    focusEditor,
    handleEditorChange,
    handleEditorSend,
    handleEditorSendLineByLine,
    handleEditorClear,
  };
}
