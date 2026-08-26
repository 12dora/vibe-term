import {
  isCopyShortcut,
  isPasteShortcut,
  writeSelectionToClipboard,
  writeSelectionToCopyEvent,
} from './selection-clipboard';

// Android Gboard 在 contenteditable 上对这些按键不发 keydown（报 keyCode 229），
// 只通过 beforeinput 的 inputType 体现且 data 多为空。按等价按键编码补发。
const SYNTHETIC_KEY_BY_INPUT_TYPE: Record<string, string> = {
  deleteContentBackward: 'Backspace',
  deleteContentForward: 'Delete',
  insertLineBreak: 'Enter',
  insertParagraph: 'Enter',
};

// compositionend 与紧随其后的 beforeinput/input 会带同一段提交文本，此窗口内视为重复。
const COMPOSITION_COMMIT_DEDUP_MS = 40;

export type KeyEncodeAction = 'press' | 'repeat' | 'release';

export type TerminalInputState = {
  composing: boolean;
  lastCompositionCommit: { data: string; at: number } | null;
  copyShortcutSuppressed: boolean;
};

export type TerminalInputContext = {
  readonly state: TerminalInputState;
  isInputDisabled(): boolean;
  getSelectionText(): string | null;
  clearSelection(): void;
  clearTextarea(): void;
  emitData(data: string): void;
  encodeKeyboardEvent(event: KeyboardEvent, action: KeyEncodeAction): string | null;
  encodeSyntheticKey(code: string): string | null;
  runCustomKeyEventHandler(event: KeyboardEvent): boolean;
  syncTextareaPositionToCursor(): void;
  paste(text: string): void;
};

export function createTerminalInputState(): TerminalInputState {
  return {
    composing: false,
    lastCompositionCommit: null,
    copyShortcutSuppressed: false,
  };
}

function shouldEncodeOnKeyDown(event: KeyboardEvent): boolean {
  const isPlainText = event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey;
  if (isPlainText) {
    return false;
  }

  return true;
}

// 读取并清空 compositionend 的提交记录：返回 true 表示 data 与刚提交的组字结果重复，
// 调用方应吞掉这次输入（beforeinput/input 与 compositionend 二选一提交）。
function consumeCompositionCommit(state: TerminalInputState, data: string): boolean {
  const recent = state.lastCompositionCommit;
  state.lastCompositionCommit = null;
  return (
    recent !== null && recent.data === data && Date.now() - recent.at < COMPOSITION_COMMIT_DEDUP_MS
  );
}

export function bindKeyboardEvents(
  textarea: HTMLElement,
  context: TerminalInputContext
): () => void {
  const state = context.state;

  const keydownListener = (event: KeyboardEvent): void => {
    const selectionText = context.getSelectionText();
    if (selectionText && isCopyShortcut(event)) {
      event.preventDefault();
      void writeSelectionToClipboard(selectionText).catch(() => {});
      context.clearSelection();
      state.copyShortcutSuppressed = true;
      context.clearTextarea();
      return;
    }

    if (!context.runCustomKeyEventHandler(event)) {
      return;
    }

    if (context.isInputDisabled() || state.composing) {
      return;
    }

    if (event.keyCode === 229) {
      return;
    }

    if (isPasteShortcut(event)) {
      return;
    }

    if (!shouldEncodeOnKeyDown(event)) {
      return;
    }

    const payload = context.encodeKeyboardEvent(event, event.repeat ? 'repeat' : 'press');
    if (!payload) {
      return;
    }

    event.preventDefault();
    context.emitData(payload);
    context.clearTextarea();
  };

  const keyupListener = (event: KeyboardEvent): void => {
    if (state.copyShortcutSuppressed) {
      const key = event.key.toLowerCase();
      if (key === 'c') {
        event.preventDefault();
        return;
      }

      if (key === 'control' || key === 'meta' || key === 'os') {
        state.copyShortcutSuppressed = false;
        event.preventDefault();
        return;
      }
    }

    if (context.isInputDisabled() || state.composing) {
      return;
    }

    const payload = context.encodeKeyboardEvent(event, 'release');
    if (!payload) {
      return;
    }

    event.preventDefault();
    context.emitData(payload);
    context.clearTextarea();
  };

  textarea.addEventListener('keydown', keydownListener);
  textarea.addEventListener('keyup', keyupListener);

  return () => {
    textarea.removeEventListener('keydown', keydownListener);
    textarea.removeEventListener('keyup', keyupListener);
  };
}

export function bindCompositionEvents(
  textarea: HTMLElement,
  context: TerminalInputContext
): () => void {
  const state = context.state;

  const compositionstartListener = (): void => {
    state.composing = true;
    state.lastCompositionCommit = null;
    context.syncTextareaPositionToCursor();
  };

  const compositionupdateListener = (): void => {
    context.syncTextareaPositionToCursor();
  };

  const compositionendListener = (event: CompositionEvent): void => {
    state.composing = false;
    const finalData = event.data ?? '';
    if (finalData) {
      state.lastCompositionCommit = { data: finalData, at: Date.now() };
      context.emitData(finalData);
      context.clearTextarea();
    }
  };

  textarea.addEventListener('compositionstart', compositionstartListener);
  textarea.addEventListener('compositionupdate', compositionupdateListener);
  textarea.addEventListener('compositionend', compositionendListener);

  return () => {
    textarea.removeEventListener('compositionstart', compositionstartListener);
    textarea.removeEventListener('compositionupdate', compositionupdateListener);
    textarea.removeEventListener('compositionend', compositionendListener);
  };
}

export function bindClipboardEvents(
  textarea: HTMLElement,
  context: TerminalInputContext
): () => void {
  const pasteListener = (event: ClipboardEvent): void => {
    if (context.isInputDisabled()) {
      return;
    }

    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (!text) {
      return;
    }

    event.preventDefault();
    context.paste(text);
    context.clearTextarea();
  };

  const copyListener = (event: ClipboardEvent): void => {
    const selectionText = context.getSelectionText();
    if (!selectionText) {
      return;
    }

    writeSelectionToCopyEvent(event, selectionText);
  };

  textarea.addEventListener('paste', pasteListener);
  textarea.addEventListener('copy', copyListener);

  return () => {
    textarea.removeEventListener('paste', pasteListener);
    textarea.removeEventListener('copy', copyListener);
  };
}

export function bindInputEvents(textarea: HTMLElement, context: TerminalInputContext): () => void {
  const state = context.state;

  const beforeinputListener = (event: InputEvent): void => {
    if (context.isInputDisabled()) {
      return;
    }

    if (event.inputType === 'insertFromPaste') {
      return;
    }

    // 组字过程中的输入/删除交给 compositionend 统一提交，这里忽略
    if (event.isComposing || state.composing) {
      return;
    }

    // Android 把退格/删除/换行等只通过 beforeinput 的 inputType 体现（无 keydown，
    // 报 keyCode 229），data 多为空。按等价按键编码补发；iOS/桌面这些键走 keydown
    // 且已 preventDefault、会抑制后续 beforeinput，两路径互斥不会重复触发。
    const syntheticKey = SYNTHETIC_KEY_BY_INPUT_TYPE[event.inputType ?? ''];
    if (syntheticKey) {
      event.preventDefault();
      const payload = context.encodeSyntheticKey(syntheticKey);
      if (payload) {
        context.emitData(payload);
      }
      context.clearTextarea();
      return;
    }

    const data = event.data ?? '';
    if (!data) {
      return;
    }

    if (consumeCompositionCommit(state, data)) {
      event.preventDefault();
      context.clearTextarea();
      return;
    }

    event.preventDefault();
    context.emitData(data);
    context.clearTextarea();
  };

  const inputListener = (): void => {
    if (context.isInputDisabled() || state.composing) {
      return;
    }

    const data = textarea.textContent ?? '';
    if (!data) {
      context.clearTextarea();
      return;
    }

    if (consumeCompositionCommit(state, data)) {
      context.clearTextarea();
      return;
    }

    context.emitData(data);
    context.clearTextarea();
  };

  textarea.addEventListener('beforeinput', beforeinputListener);
  textarea.addEventListener('input', inputListener);

  return () => {
    textarea.removeEventListener('beforeinput', beforeinputListener);
    textarea.removeEventListener('input', inputListener);
  };
}
