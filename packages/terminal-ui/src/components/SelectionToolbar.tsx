import { ClipboardPaste, Copy, X } from 'lucide-react';
import { forwardRef, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { createToolbarActionBinder } from './selection-toolbar-action';

interface SelectionToolbarProps {
  visible: boolean;
  canPaste: boolean;
  showCopy?: boolean;
  style?: { left: number; top: number };
  onCopy: () => void;
  onPaste: () => void;
  onDismiss: () => void;
}

export const SelectionToolbar = forwardRef<HTMLDivElement, SelectionToolbarProps>(
  function SelectionToolbar(
    { visible, canPaste, showCopy = true, style, onCopy, onPaste, onDismiss },
    ref
  ) {
    const { t } = useTranslation();
    const copyRef = useRef(onCopy);
    const pasteRef = useRef(onPaste);
    const dismissRef = useRef(onDismiss);
    copyRef.current = onCopy;
    pasteRef.current = onPaste;
    dismissRef.current = onDismiss;

    const copyAction = useMemo(() => createToolbarActionBinder(() => copyRef.current()), []);
    const pasteAction = useMemo(() => createToolbarActionBinder(() => pasteRef.current()), []);
    const dismissAction = useMemo(() => createToolbarActionBinder(() => dismissRef.current()), []);

    if (!visible) {
      return null;
    }

    const anchored = style !== undefined;
    const className = anchored
      ? 'vibeterm-reveal absolute z-20 flex items-center gap-1 rounded-lg border bg-background/95 p-1 shadow-md backdrop-blur'
      : 'vibeterm-reveal absolute top-2 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-lg border bg-background/95 p-1 shadow-md backdrop-blur';

    return (
      <div
        ref={ref}
        className={className}
        style={anchored ? { left: style.left, top: style.top } : undefined}
        data-testid="terminal-selection-toolbar"
      >
        {showCopy && (
          <button
            type="button"
            className="flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors duration-(--vibeterm-motion-fast) ease-out hover:bg-accent hover:text-accent-foreground motion-reduce:transition-none"
            onPointerUp={copyAction.onPointerUp}
            onMouseDown={copyAction.onMouseDown}
            onClick={copyAction.onClick}
            data-testid="terminal-selection-copy"
          >
            <Copy className="h-4 w-4" />
            {t('terminal.copy')}
          </button>
        )}
        {canPaste && (
          <button
            type="button"
            className="flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors duration-(--vibeterm-motion-fast) ease-out hover:bg-accent hover:text-accent-foreground motion-reduce:transition-none"
            onPointerUp={pasteAction.onPointerUp}
            onMouseDown={pasteAction.onMouseDown}
            onClick={pasteAction.onClick}
            data-testid="terminal-selection-paste"
          >
            <ClipboardPaste className="h-4 w-4" />
            {t('terminal.paste')}
          </button>
        )}
        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--vibeterm-motion-fast) ease-out hover:bg-accent hover:text-accent-foreground motion-reduce:transition-none"
          onPointerUp={dismissAction.onPointerUp}
          onMouseDown={dismissAction.onMouseDown}
          onClick={dismissAction.onClick}
          aria-label={t('terminal.clearSelection')}
          data-testid="terminal-selection-dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }
);
