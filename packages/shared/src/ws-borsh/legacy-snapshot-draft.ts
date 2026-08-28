// legacy 快照 diff 的写时复制草稿：只克隆被 diff 触碰的 window / pane，
// 未触碰的 window、pane 及其数组保持原引用。
// pane 定位优先在目标 window 内直接命中；只有跨 window 移动或新建时才建立全局 id 索引，
// 之后增量维护，避免每次 apply 都遍历全部 pane。

import type { TmuxPane, TmuxSession, TmuxWindow } from '../index';
import { type LegacyMetadataFields, applyPaneFields } from './legacy-pane-fields';
import { applySessionFields, applyWindowFields } from './legacy-window-fields';

interface WindowSlot {
  readonly id: string;
  readonly base: TmuxWindow;
  draft: TmuxWindow | null;
  appended: TmuxPane[] | null;
  detached: Set<string> | null;
  dirty: boolean;
  panesDirty: boolean;
  removed: boolean;
}

interface TouchedPane {
  readonly pane: TmuxPane;
  window: WindowSlot;
}

export class LegacySnapshotDraft {
  private session: TmuxSession | null;
  private windows: WindowSlot[] = [];
  private windowSlots = new Map<string, WindowSlot>();
  private touched = new Map<string, TouchedPane>();
  private removedPanes = new Set<string>();
  private owners: Map<string, WindowSlot> | null = null;

  constructor(session: TmuxSession | null) {
    this.session = session ? { ...session, windows: [] } : null;
    for (const window of session?.windows ?? []) {
      const slot: WindowSlot = {
        id: window.id,
        base: window,
        draft: null,
        appended: null,
        detached: null,
        dirty: false,
        panesDirty: false,
        removed: false,
      };
      this.windows.push(slot);
      this.windowSlots.set(window.id, slot);
    }
  }

  removeSession(id: string): void {
    if (this.session?.id !== id) return;
    this.session = null;
    this.resetTree();
  }

  removeWindow(id: string): void {
    const slot = this.windowSlots.get(id);
    if (!slot) return;
    slot.removed = true;
    this.windowSlots.delete(id);
    const owners = this.owners;
    if (!owners) return;
    for (const pane of slot.base.panes) {
      if (owners.get(pane.id) === slot) owners.delete(pane.id);
    }
    for (const pane of slot.appended ?? []) {
      if (owners.get(pane.id) === slot) owners.delete(pane.id);
    }
  }

  removePane(id: string): void {
    const owner = this.findOwner(id);
    if (!owner) return;
    this.removedPanes.add(id);
    this.touched.delete(id);
    this.owners?.delete(id);
    this.detach(owner, id);
    owner.dirty = true;
  }

  upsertSession(id: string, fields: LegacyMetadataFields): void {
    if (!this.session || this.session.id !== id) {
      this.session = { id, name: '', windows: [] };
      this.resetTree();
    }
    applySessionFields(this.session, fields);
  }

  upsertWindow(id: string, fields: LegacyMetadataFields): void {
    if (!this.session) return;
    const slot = this.windowSlots.get(id) ?? this.createWindow(id);
    applyWindowFields(this.mutableWindow(slot), fields);
  }

  upsertPane(id: string, parentId: string, fields: LegacyMetadataFields): void {
    if (!this.session) return;
    const destination = this.windowSlots.get(parentId);
    if (!destination) return;
    const pane = this.paneForUpsert(id, destination);
    pane.windowId = destination.id;
    destination.dirty = true;
    applyPaneFields(pane, fields);
  }

  toSession(): TmuxSession | null {
    const session = this.session;
    if (!session) return null;
    const windows: TmuxWindow[] = [];
    for (const slot of this.windows) {
      if (slot.removed) continue;
      windows.push(
        slot.dirty ? { ...(slot.draft ?? slot.base), panes: this.resolvePanes(slot) } : slot.base
      );
    }
    session.windows = windows;
    return session;
  }

  private resetTree(): void {
    this.windows = [];
    this.windowSlots.clear();
    this.touched.clear();
    this.removedPanes.clear();
    this.owners = new Map();
  }

  private createWindow(id: string): WindowSlot {
    const base: TmuxWindow = { id, name: '', index: 0, active: false, panes: [] };
    const slot: WindowSlot = {
      id,
      base,
      draft: base,
      appended: null,
      detached: null,
      dirty: true,
      panesDirty: true,
      removed: false,
    };
    this.windows.push(slot);
    this.windowSlots.set(id, slot);
    return slot;
  }

  private mutableWindow(slot: WindowSlot): TmuxWindow {
    slot.dirty = true;
    if (!slot.draft) slot.draft = { ...slot.base };
    return slot.draft;
  }

  private paneForUpsert(id: string, destination: WindowSlot): TmuxPane {
    if (this.isOwnedBy(destination, id)) return this.mutablePane(id, destination);
    const owner = this.findOwner(id);
    if (!owner) return this.createPane(id, destination);
    const pane = this.mutablePane(id, owner);
    this.detach(owner, id);
    owner.dirty = true;
    this.attach(destination, pane);
    return pane;
  }

  private isOwnedBy(window: WindowSlot, id: string): boolean {
    if (this.removedPanes.has(id)) return false;
    const touched = this.touched.get(id);
    if (touched) return touched.window === window && !window.removed;
    if (this.owners) return this.owners.get(id) === window;
    return window.base.panes.some((pane) => pane.id === id);
  }

  private findOwner(id: string): WindowSlot | null {
    if (this.removedPanes.has(id)) return null;
    const touched = this.touched.get(id);
    const owner = touched ? touched.window : (this.owners ?? this.buildOwners()).get(id);
    return owner && !owner.removed ? owner : null;
  }

  private buildOwners(): Map<string, WindowSlot> {
    const owners = new Map<string, WindowSlot>();
    for (const window of this.windows) {
      if (window.removed) continue;
      for (const pane of window.base.panes) {
        if (!window.detached?.has(pane.id)) owners.set(pane.id, window);
      }
      for (const pane of window.appended ?? []) owners.set(pane.id, window);
    }
    for (const id of this.removedPanes) owners.delete(id);
    this.owners = owners;
    return owners;
  }

  private mutablePane(id: string, owner: WindowSlot): TmuxPane {
    const touched = this.touched.get(id);
    if (touched) return touched.pane;
    const base = owner.base.panes.find((pane) => pane.id === id);
    if (!base) return this.createPane(id, owner);
    const clone = { ...base };
    this.touched.set(id, { pane: clone, window: owner });
    owner.panesDirty = true;
    return clone;
  }

  private createPane(id: string, window: WindowSlot): TmuxPane {
    const pane: TmuxPane = {
      id,
      windowId: window.id,
      index: 0,
      active: false,
      width: 1,
      height: 1,
    };
    this.removedPanes.delete(id);
    this.attach(window, pane);
    return pane;
  }

  private attach(window: WindowSlot, pane: TmuxPane): void {
    window.panesDirty = true;
    if (window.appended) window.appended.push(pane);
    else window.appended = [pane];
    this.touched.set(pane.id, { pane, window });
    this.owners?.set(pane.id, window);
  }

  private detach(window: WindowSlot, id: string): void {
    window.panesDirty = true;
    if (window.base.panes.some((pane) => pane.id === id)) {
      if (window.detached) window.detached.add(id);
      else window.detached = new Set([id]);
    }
    if (window.appended) window.appended = window.appended.filter((pane) => pane.id !== id);
  }

  private resolvePanes(slot: WindowSlot): TmuxPane[] {
    if (!slot.panesDirty) return slot.base.panes;
    const panes: TmuxPane[] = [];
    for (const pane of slot.base.panes) {
      if (this.removedPanes.has(pane.id) || slot.detached?.has(pane.id)) continue;
      panes.push(this.touched.get(pane.id)?.pane ?? pane);
    }
    for (const pane of slot.appended ?? []) panes.push(pane);
    return panes;
  }
}
