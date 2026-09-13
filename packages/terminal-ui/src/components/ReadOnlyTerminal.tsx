import { cn } from '@vibeterm/ui';
import type { KeyboardEvent, PointerEvent, RefObject } from 'react';
import { SelectionToolbar } from './SelectionToolbar';
import { readOnlySurfaceBackdrop } from './hooks/read-only-surface-frame';
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
  /** 录像回放用：内容表面按「屏幕」画——外圈换衬底、描一圈边、小于外框时居中。 */
  surfaceFrame?: boolean;
  selection?: boolean;
  scrollback?: number;
  onReady?: (handle: ReadOnlyTerminalHandle) => void;
  onDispose?: () => void;
  testId?: string;
  ariaLabel?: string;
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
  surfaceFrame = false,
  selection = false,
  scrollback = READ_ONLY_TERMINAL_SCROLLBACK,
  onReady,
  onDispose,
  testId = 'read-only-terminal',
  ariaLabel,
}: ReadOnlyTerminalProps) {
  const { containerRef, mountRef, instance, terminalTheme } = useReadOnlyTerminal({
    viewportPan,
    surfaceFrame,
    scrollback,
    onReady,
    onDispose,
  });
  const chrome = useTerminalSelectionChrome(selection ? instance : null, containerRef, {
    readOnly: true,
  });

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!isReadOnlyCopyShortcut(event.nativeEvent)) return;
    const text = instance?.getSelection?.() ?? '';
    if (!text) return;
    event.preventDefault();
    chrome.copySelection();
  };

  const handlePointerDownCapture = (event: PointerEvent<HTMLElement>) => {
    containerRef.current?.focus();
    chrome.handlePointerDownCapture(event);
  };

  return (
    <section
      ref={containerRef}
      className={cn('relative h-full w-full', className)}
      style={{
        backgroundColor: surfaceFrame
          ? readOnlySurfaceBackdrop(terminalTheme)
          : terminalTheme.background,
      }}
      data-testid={testId}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: 可滚动只读区域需能 Tab 进入以复制
      tabIndex={0}
      aria-label={ariaLabel}
      onKeyDown={selection ? handleKeyDown : undefined}
      onPointerDownCapture={selection ? handlePointerDownCapture : undefined}
      onPointerUp={selection ? chrome.handlePointerUp : undefined}
    >
      <div ref={mountRef} className="absolute inset-0" />
      {selection ? <ReadOnlySelectionToolbar {...chrome} /> : null}
    </section>
  );
}
