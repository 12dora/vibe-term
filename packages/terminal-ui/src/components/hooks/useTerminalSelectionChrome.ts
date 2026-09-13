import type { CompatibleTerminalLike } from 'ghostty-terminal';
import { type RefObject, useCallback, useRef } from 'react';
import { shouldDismissSelectionOnPointerDown } from '../selection-dismiss';
import { useMobileTouch } from '../useMobileTouch';
import { useSelectionAnchor } from './useSelectionAnchor';
import { useTerminalClipboard } from './useTerminalClipboard';

export function useTerminalSelectionChrome(
  instance: CompatibleTerminalLike | null,
  containerRef: RefObject<HTMLElement | null>
) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const {
    hasSelection,
    showCopyButton,
    copySelection,
    pasteClipboard,
    dismissSelection,
    commitSelectionCopy,
  } = useTerminalClipboard({ instance });
  const selectionAnchor = useSelectionAnchor({
    instance,
    containerRef,
    toolbarRef,
    hasSelection,
  });

  const getTerminalForTouch = useCallback(() => instance, [instance]);
  useMobileTouch(containerRef, getTerminalForTouch, {
    onSelectionCommitted: commitSelectionCopy,
  });

  const handlePointerDownCapture = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (
        shouldDismissSelectionOnPointerDown({
          hasSelection,
          pointerType: event.pointerType,
          button: event.button,
          target: event.target,
        })
      ) {
        dismissSelection();
      }
    },
    [hasSelection, dismissSelection]
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === 'touch') return;
      commitSelectionCopy();
    },
    [commitSelectionCopy]
  );

  return {
    toolbarRef,
    hasSelection,
    showCopyButton,
    copySelection,
    pasteClipboard,
    dismissSelection,
    commitSelectionCopy,
    selectionAnchor,
    handlePointerDownCapture,
    handlePointerUp,
  };
}
