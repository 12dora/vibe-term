import { create } from 'zustand';

interface BellState {
  ringingPanes: Record<string, boolean>;
  triggerBell: (paneId: string) => void;
  clearBell: (paneId: string) => void;
}

export const useBellStore = create<BellState>((set) => ({
  ringingPanes: {},
  triggerBell: (paneId) => {
    set((state) => ({ ringingPanes: { ...state.ringingPanes, [paneId]: true } }));
    setTimeout(() => {
      set((state) => {
        const next = { ...state.ringingPanes };
        delete next[paneId];
        return { ringingPanes: next };
      });
    }, 1500);
  },
  clearBell: (paneId) =>
    set((state) => {
      const next = { ...state.ringingPanes };
      delete next[paneId];
      return { ringingPanes: next };
    }),
}));
