export const GHOSTTY_MOUSE_BUTTON_LEFT = 1;
export const GHOSTTY_MOUSE_BUTTON_MIDDLE = 3;
export const GHOSTTY_MOUSE_BUTTON_RIGHT = 2;

export type MouseDownInput = {
  reporting: boolean;
  shiftBypass: boolean;
  button: number | null;
  platformModifier: boolean;
  hasLink: boolean;
};

export type MouseDownDecision = (
  | { kind: 'ignore' }
  | { kind: 'report'; button: number }
  | { kind: 'activateLink' }
  | { kind: 'beginSelection' }
) & { recordBypass: boolean };

export function mouseButtonFromEvent(event: MouseEvent): number | null {
  switch (event.button) {
    case 0:
      return GHOSTTY_MOUSE_BUTTON_LEFT;
    case 1:
      return GHOSTTY_MOUSE_BUTTON_MIDDLE;
    case 2:
      return GHOSTTY_MOUSE_BUTTON_RIGHT;
    default:
      return null;
  }
}

export function mouseButtonFromButtons(buttons: number): number | null {
  if (buttons & 1) {
    return GHOSTTY_MOUSE_BUTTON_LEFT;
  }
  if (buttons & 4) {
    return GHOSTTY_MOUSE_BUTTON_MIDDLE;
  }
  if (buttons & 2) {
    return GHOSTTY_MOUSE_BUTTON_RIGHT;
  }

  return null;
}

// xterm 约定：Shift+左键绕过鼠标上报、走本地文本选择（上报 TUI 下唯一的复制入口）
export function isShiftReportingBypass(
  reporting: boolean,
  shiftKey: boolean,
  button: number | null
): boolean {
  return reporting && shiftKey && button === GHOSTTY_MOUSE_BUTTON_LEFT;
}

// mousedown 的纯策略：顺序即优先级——先鼠标上报（vim/htop 等应用优先，Shift 绕过除外），
// 再带平台主修饰键的链接激活，最后才是本地文本选择；不可调换。
export function classifyMouseDown(input: MouseDownInput): MouseDownDecision {
  if (input.reporting && !input.shiftBypass) {
    if (input.button === null) {
      return { kind: 'ignore', recordBypass: false };
    }
    return { kind: 'report', button: input.button, recordBypass: false };
  }

  const recordBypass = input.shiftBypass;
  if (input.button !== GHOSTTY_MOUSE_BUTTON_LEFT) {
    return { kind: 'ignore', recordBypass };
  }
  if (input.platformModifier && input.hasLink) {
    return { kind: 'activateLink', recordBypass };
  }

  return { kind: 'beginSelection', recordBypass };
}
