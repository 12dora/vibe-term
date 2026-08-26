import { create } from 'zustand';

interface BellState {
  ringingPanes: Record<string, boolean>;
  triggerBell: (paneId: string) => void;
  clearBell: (paneId: string) => void;
}

const BELL_DURATION_MS = 1500;

const bellTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelBellTimer(paneId: string): void {
  const timer = bellTimers.get(paneId);
  if (timer === undefined) return;
  clearTimeout(timer);
  bellTimers.delete(paneId);
}

export const useBellStore = create<BellState>((set) => ({
  ringingPanes: {},
  triggerBell: (paneId) => {
    cancelBellTimer(paneId);
    set((state) => ({ ringingPanes: { ...state.ringingPanes, [paneId]: true } }));
    const timer = setTimeout(() => {
      bellTimers.delete(paneId);
      set((state) => {
        const next = { ...state.ringingPanes };
        delete next[paneId];
        return { ringingPanes: next };
      });
    }, BELL_DURATION_MS);
    bellTimers.set(paneId, timer);
  },
  clearBell: (paneId) => {
    cancelBellTimer(paneId);
    set((state) => {
      const next = { ...state.ringingPanes };
      delete next[paneId];
      return { ringingPanes: next };
    });
  },
}));
