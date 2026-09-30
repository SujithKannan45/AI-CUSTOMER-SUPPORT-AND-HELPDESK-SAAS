import { create } from 'zustand';

export interface UiState {
  /** Mobile-first: sidebar collapses into an overlay below `lg`. */
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  closeSidebar: () => void;

  /** Theme preference ('system' follows the OS setting). */
  theme: 'light' | 'dark' | 'system';
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarOpen: false,
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  closeSidebar: () => set({ sidebarOpen: false }),

  theme: 'system',
  setTheme: (theme) => set({ theme }),
}));
