export class MinHeap<T> {
  private readonly items: T[] = [];

  constructor(private readonly compare: (left: T, right: T) => number) {}

  get size(): number {
    return this.items.length;
  }

  push(value: T): void {
    this.items.push(value);
    this.siftUp(this.items.length - 1);
  }

  pop(): T | undefined {
    const root = this.items[0];
    const last = this.items.pop();
    if (this.items.length === 0 || last === undefined) return root;
    this.items[0] = last;
    this.siftDown(0);
    return root;
  }

  private siftUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const current = this.items[index];
      const parentItem = this.items[parent];
      if (current === undefined || parentItem === undefined) return;
      if (this.compare(current, parentItem) >= 0) return;
      this.items[index] = parentItem;
      this.items[parent] = current;
      index = parent;
    }
  }

  private siftDown(start: number): void {
    const length = this.items.length;
    let index = start;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < length && this.isSmaller(left, smallest)) smallest = left;
      if (right < length && this.isSmaller(right, smallest)) smallest = right;
      if (smallest === index) return;
      const current = this.items[index];
      const next = this.items[smallest];
      if (current === undefined || next === undefined) return;
      this.items[index] = next;
      this.items[smallest] = current;
      index = smallest;
    }
  }

  private isSmaller(left: number, right: number): boolean {
    const leftItem = this.items[left];
    const rightItem = this.items[right];
    return (
      leftItem !== undefined && rightItem !== undefined && this.compare(leftItem, rightItem) < 0
    );
  }
}
