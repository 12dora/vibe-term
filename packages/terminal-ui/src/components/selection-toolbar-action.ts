export interface ToolbarActionEvent {
  preventDefault(): void;
}

export interface ToolbarPointerEvent extends ToolbarActionEvent {
  pointerType: string;
}

export interface ToolbarActionHandlers {
  onPointerUp(event: ToolbarPointerEvent): void;
  onClick(): void;
  onMouseDown(event: ToolbarActionEvent): void;
}

/** 触屏走 pointerup（并 preventDefault 压合成鼠标/click），鼠标走 click；用标志位防双发。 */
export function createToolbarActionBinder(action: () => void): ToolbarActionHandlers {
  let touchHandled = false;

  return {
    onPointerUp(event) {
      if (event.pointerType !== 'touch') {
        return;
      }
      event.preventDefault();
      touchHandled = true;
      action();
    },
    onClick() {
      if (touchHandled) {
        touchHandled = false;
        return;
      }
      action();
    },
    onMouseDown(event) {
      if (touchHandled) {
        return;
      }
      event.preventDefault();
    },
  };
}
