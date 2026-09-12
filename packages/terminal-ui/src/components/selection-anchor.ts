export interface SelectionAnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SelectionToolbarPlacement {
  left: number;
  top: number;
  placement: 'above' | 'below';
}

const TOOLBAR_INSET = 8;

export function placeSelectionToolbar({
  selection,
  container,
  toolbar,
  gap,
}: {
  selection: SelectionAnchorRect;
  container: SelectionAnchorRect;
  toolbar: { width: number; height: number };
  gap: number;
}): SelectionToolbarPlacement {
  const localTop = selection.top - container.top;
  const roomAbove = localTop >= toolbar.height + gap;
  const placement = roomAbove ? 'above' : 'below';
  const top = roomAbove ? localTop - toolbar.height - gap : localTop + selection.height + gap;

  const center = selection.left + selection.width / 2 - container.left;
  const unclamped = center - toolbar.width / 2;
  const maxLeft = Math.max(TOOLBAR_INSET, container.width - toolbar.width - TOOLBAR_INSET);
  const left = Math.min(Math.max(unclamped, TOOLBAR_INSET), maxLeft);

  return { left, top, placement };
}
