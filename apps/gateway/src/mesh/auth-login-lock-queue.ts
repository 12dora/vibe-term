export type LockTicket = { key: string; until: number; gen: number };

/** 空闲键按触碰后的插入序排；锁按到期时间进堆。 */
export class LockQueue {
  private heap: LockTicket[] = [];

  arm(idle: Map<string, true>, key: string, until: number, gen: number): void {
    idle.delete(key);
    pushTicket(this.heap, { key, until, gen });
  }

  touch(idle: Map<string, true>, key: string): void {
    idle.delete(key);
    idle.set(key, true);
  }

  take(idle: Map<string, true>, live: (key: string, gen: number) => boolean): string | null {
    const oldest = idle.keys().next().value as string | undefined;
    if (oldest !== undefined) {
      idle.delete(oldest);
      return oldest;
    }
    while (this.heap.length > 0) {
      const top = popMin(this.heap);
      if (!top) return null;
      if (live(top.key, top.gen)) return top.key;
    }
    return null;
  }

  rebuild(tickets: LockTicket[]): void {
    this.heap = tickets;
    for (let i = Math.floor(this.heap.length / 2) - 1; i >= 0; i -= 1) siftDown(this.heap, i);
  }
}

function pushTicket(heap: LockTicket[], ticket: LockTicket): void {
  heap.push(ticket);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    const cur = heap[i];
    const par = heap[parent];
    if (!cur || !par || par.until <= cur.until) return;
    heap[parent] = cur;
    heap[i] = par;
    i = parent;
  }
}

function popMin(heap: LockTicket[]): LockTicket | null {
  const last = heap.pop();
  if (!last) return null;
  if (heap.length === 0) return last;
  const top = heap[0];
  if (!top) return last;
  heap[0] = last;
  siftDown(heap, 0);
  return top;
}

function siftDown(heap: LockTicket[], index: number): void {
  let i = index;
  while (i * 2 + 1 < heap.length) {
    const left = i * 2 + 1;
    const right = left + 1;
    let best = left;
    const rightTicket = heap[right];
    const leftTicket = heap[left];
    if (rightTicket && leftTicket && rightTicket.until < leftTicket.until) best = right;
    const parent = heap[i];
    const child = heap[best];
    if (!parent || !child || parent.until <= child.until) return;
    heap[i] = child;
    heap[best] = parent;
    i = best;
  }
}
