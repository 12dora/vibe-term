// 快捷键栏额外位移量（--tmex-kb-shortcut-lift）的写入器。
//
// follow 模式的 RAF 每帧都会调它，而写 CSS 自定义属性会让目标元素整棵子树的样式失效，
// 因此取整后与上次写入值相同就不再写。目标元素取快捷键栏所在的浮层（唯一消费者，作用域
// 最小），拿不到时回落到 documentElement。换目标必须重置去重记录：新挂上来的元素身上还
// 没有这个变量，沿用旧记录会让它一直停在缺省值 0。
export class ShortcutLiftWriter {
  private target: HTMLElement | null = null;
  private written: number | null = null;
  /** 最近一次要求的位移量（取整后）；对齐迭代把它当累加器用。 */
  applied = 0;

  constructor(private readonly varName: string) {}

  set(px: number, target: HTMLElement | null): void {
    this.applied = Math.round(px);
    if (target !== this.target) {
      this.clear();
      this.target = target;
    }
    if (!target || this.written === this.applied) {
      return;
    }
    this.written = this.applied;
    target.style.setProperty(this.varName, `${this.applied}px`);
  }

  clear(): void {
    if (this.target && this.written !== null) {
      this.target.style.removeProperty(this.varName);
    }
    this.written = null;
  }

  dispose(): void {
    this.clear();
    this.target = null;
    this.applied = 0;
  }
}
