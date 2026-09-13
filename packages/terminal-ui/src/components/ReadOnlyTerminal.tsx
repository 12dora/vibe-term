import { cn } from '@vibeterm/ui';
import type { KeyboardEvent, PointerEvent, RefObject } from 'react';
import { SelectionToolbar } from './SelectionToolbar';
import {
  READ_ONLY_TERMINAL_SCROLLBACK,
  type ReadOnlyTerminalHandle,
  isReadOnlyCopyShortcut,
} from './hooks/read-only-terminal-session';
import { useReadOnlyTerminal } from './hooks/useReadOnlyTerminal';
import { useTerminalSelectionChrome } from './hooks/useTerminalSelectionChrome';

export type { ReadOnlyTerminalHandle };
export { READ_ONLY_TERMINAL_SCROLLBACK };

export interface ReadOnlyTerminalProps {
  className?: string;
  viewportPan?: boolean;
  selection?: boolean;
  scrollback?: number;
  onReady?: (handle: ReadOnlyTerminalHandle) => void;
  onDispose?: () => void;
  testId?: string;
}

export function ReadOnlySelectionToolbar(chrome: {
  toolbarRef: RefObject<HTMLDivElement | null>;
  hasSelection: boolean;
  showCopyButton: boolean;
  selectionAnchor: { left: number; top: number } | null;
  copySelection: () => void;
  pasteClipboard: () => void;
  dismissSelection: () => void;
}) {
  return (
    <SelectionToolbar
      ref={chrome.toolbarRef}
      visible={chrome.hasSelection}
      showCopy={chrome.showCopyButton}
      canPaste={false}
      style={chrome.selectionAnchor ?? undefined}
      onCopy={chrome.copySelection}
      onPaste={chrome.pasteClipboard}
      onDismiss={chrome.dismissSelection}
    />
  );
}

export function ReadOnlyTerminal({
  className,
  viewportPan = false,
  selection = false,
  scrollback = READ_ONLY_TERMINAL_SCROLLBACK,
  onReady,
  onDispose,
  testId = 'read-only-terminal',
}: ReadOnlyTerminalProps) {
  const { containerRef, mountRef, instance, terminalTheme } = useReadOnlyTerminal({
    viewportPan,
    scrollback,
    onReady,
    onDispose,
  });
  const chrome = useTerminalSelectionChrome(selection ? instance : null, containerRef);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isReadOnlyCopyShortcut(event.nativeEvent)) return;
    const text = instance?.getSelection?.() ?? '';
    if (!text) return;
    event.preventDefault();
    chrome.copySelection();
  };

  const handlePointerDownCapture = (event: PointerEvent<HTMLDivElement>) => {
    containerRef.current?.focus();
    chrome.handlePointerDownCapture(event);
  };

  return (
    <div
      ref={containerRef}
      className={cn('relative h-full w-full', className)}
      style={{ backgroundColor: terminalTheme.background }}
      data-testid={testId}
      tabIndex={selection ? -1 : undefined}
      onKeyDown={selection ? handleKeyDown : undefined}
      onPointerDownCapture={selection ? handlePointerDownCapture : undefined}
      onPointerUp={selection ? chrome.handlePointerUp : undefined}
    >
      <div ref={mountRef} className="absolute inset-0" />
      {selection ? <ReadOnlySelectionToolbar {...chrome} /> : null}
    </div>
  );
}
