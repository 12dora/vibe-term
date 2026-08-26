import { SCROLLBAR_TOUCH_HOTZONE_PX, isInsideRightEdgeHotzone } from './touch-geometry';

const SCROLLBAR_SELECTORS = ['.scrollbar', '.slider', '.xterm-scroll-area'];

export type ElementFromPoint = (clientX: number, clientY: number) => Element | null;

export const documentElementFromPoint: ElementFromPoint = (clientX, clientY) =>
  document.elementFromPoint(clientX, clientY);

export function isScrollbarElement(target: Element | null): boolean {
  if (!target) return false;
  return SCROLLBAR_SELECTORS.some((selector) => target.closest(selector) !== null);
}

export function hitsScrollbarElement(
  clientX: number,
  clientY: number,
  eventTarget: EventTarget | null,
  elementFromPoint: ElementFromPoint = documentElementFromPoint
): boolean {
  const directTarget = eventTarget instanceof Element ? eventTarget : null;
  if (isScrollbarElement(directTarget)) {
    return true;
  }
  return isScrollbarElement(elementFromPoint(clientX, clientY));
}

export function shouldBypassCustomScroll(
  container: Element,
  clientX: number,
  clientY: number,
  eventTarget: EventTarget | null,
  elementFromPoint: ElementFromPoint = documentElementFromPoint
): boolean {
  if (hitsScrollbarElement(clientX, clientY, eventTarget, elementFromPoint)) {
    return true;
  }

  const xtermRoot = container.querySelector('.xterm');
  if (!(xtermRoot instanceof HTMLElement)) {
    return false;
  }

  return isInsideRightEdgeHotzone(
    xtermRoot.getBoundingClientRect(),
    clientX,
    clientY,
    SCROLLBAR_TOUCH_HOTZONE_PX
  );
}

export function findScrollTargets(container: Element): HTMLElement[] {
  const candidates = [
    container.querySelector('.xterm-viewport'),
    container.querySelector('.xterm-scrollable-element'),
  ];

  return candidates.filter((el): el is HTMLElement => el instanceof HTMLElement);
}
