// 链接悬停在 screen 元素上的表现：pointer 光标 + 原生 title 提示。只在状态变化时写 DOM。
export class LinkHoverStyle {
  private cursor = false;
  private title: string | null = null;

  apply(element: HTMLElement | null, active: boolean, title: string | null): void {
    if (this.cursor !== active) {
      this.cursor = active;
      if (element) element.style.cursor = active ? 'pointer' : '';
    }
    if (this.title !== title) {
      this.title = title;
      if (element) element.title = title ?? '';
    }
  }
}
