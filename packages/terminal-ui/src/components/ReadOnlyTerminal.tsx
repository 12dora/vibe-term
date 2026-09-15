import { cn } from '@vibeterm/ui';
import type { KeyboardEvent, PointerEvent, RefObject } from 'react';
import { SelectionToolbar } from './SelectionToolbar';
import {
  READ_ONLY_TERMINAL_SCROLLBACK,
  type ReadOnlyGrid,
  type ReadOnlyTerminalHandle,
  isReadOnlyCopyShortcut,
} from './hooks/read-only-terminal-session';
import { useReadOnlyTerminal } from './hooks/useReadOnlyTerminal';
import { useTerminalSelectionChrome } from './hooks/useTerminalSelectionChrome';

export type { ReadOnlyGrid, ReadOnlyTerminalHandle };
export { READ_ONLY_TERMINAL_SCROLLBACK };

export interface ReadOnlyTerminalProps {
  className?: string;
  viewportPan?: boolean;
  selection?: boolean;
  /** 录像回放用：生效网格不会小于这个包络，容器更大时照样铺满容器。 */
  minGrid?: ReadOnlyGrid | null;
  /** 生效网格变化（开面那次不算）：回放据此清屏重放。 */
  onGridChange?: (cols: number, rows: number) => void;
  /** 覆盖设置里的终端字号（回放要按录像网格自适应）；行高与字体仍取设置。 */
  fontSize?: number;
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
  selection = false,
  minGrid = null,
  onGridChange,
  fontSize,
  scrollback = READ_ONLY_TERMINAL_SCROLLBACK,
  onReady,
  onDispose,
  testId = 'read-only-terminal',
  ariaLabel,
}: ReadOnlyTerminalProps) {
  const { containerRef, mountRef, instance, terminalTheme } = useReadOnlyTerminal({
    viewportPan,
    fontSize,
    minGrid,
    onGridChange,
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
      style={{ backgroundColor: terminalTheme.background }}
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
