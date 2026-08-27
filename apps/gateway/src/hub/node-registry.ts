import type { LinkSession } from '@tmex/shared/link';

export type NodeRegistryMeta = {
  name: string;
  version: string | null;
  tmux: boolean;
  directCapable: boolean;
  inventory: unknown;
  endpoints: unknown;
};

export type RegisteredNode = {
  nodeId: string;
  userId: string;
  link: LinkSession;
  meta: NodeRegistryMeta;
  lastSeen: number;
  authenticated: boolean;
  generation: number;
};

const EMPTY_META: NodeRegistryMeta = {
  name: '',
  version: null,
  tmux: false,
  directCapable: false,
  inventory: null,
  endpoints: null,
};

export class NodeRegistry {
  private readonly nodes = new Map<string, RegisteredNode>();
  private generation = 0;

  get(nodeId: string): RegisteredNode | undefined {
    return this.nodes.get(nodeId);
  }

  listAuthenticated(): RegisteredNode[] {
    return [...this.nodes.values()].filter((n) => n.authenticated);
  }

  listForBroadcast(userId: string): RegisteredNode[] {
    return this.listAuthenticated().filter((n) => n.userId === userId);
  }

  put(entry: Omit<RegisteredNode, 'generation'>): RegisteredNode {
    const previous = this.nodes.get(entry.nodeId);
    if (previous && previous.link !== entry.link) {
      previous.link.close('replaced');
    }
    const generation = ++this.generation;
    const registered: RegisteredNode = { ...entry, generation };
    this.nodes.set(entry.nodeId, registered);
    return registered;
  }

  touch(nodeId: string, now: number): void {
    const entry = this.nodes.get(nodeId);
    if (!entry) return;
    entry.lastSeen = now;
  }

  updateMeta(nodeId: string, patch: Partial<NodeRegistryMeta>, now: number): void {
    const entry = this.nodes.get(nodeId);
    if (!entry) return;
    entry.meta = { ...entry.meta, ...patch };
    entry.lastSeen = now;
  }

  remove(nodeId: string, generation?: number): RegisteredNode | undefined {
    const entry = this.nodes.get(nodeId);
    if (!entry) return undefined;
    if (generation !== undefined && entry.generation !== generation) return undefined;
    this.nodes.delete(nodeId);
    return entry;
  }

  closeAll(reason = 'hub-stop'): void {
    const links = [...this.nodes.values()].map((n) => n.link);
    this.nodes.clear();
    for (const link of links) {
      link.close(reason);
    }
  }

  emptyMeta(name = ''): NodeRegistryMeta {
    return { ...EMPTY_META, name };
  }
}
