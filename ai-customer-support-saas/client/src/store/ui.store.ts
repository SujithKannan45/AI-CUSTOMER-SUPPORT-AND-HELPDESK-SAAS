import { create } from 'zustand';
import { readStorage, STORAGE_KEYS, writeStorage } from '@/utils/storage.util';
import { isThemePreference, type ThemePreference } from '@/utils/theme.util';

export interface UiState {
  /** Mobile-first: the sidebar collapses into an overlay below `lg`. */
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  closeSidebar: () => void;

  /** Theme preference ('system' follows the OS setting). Persisted locally. */
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
}

function initialTheme(): ThemePreference {
  const stored = readStorage(STORAGE_KEYS.theme);
  return isThemePreference(stored) ? stored : 'system';
}

export const useUiStore = create<UiState>((set) => ({
  sidebarOpen: false,
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  closeSidebar: () => set({ sidebarOpen: false }),

  theme: initialTheme(),
  setTheme: (theme) => {
    writeStorage(STORAGE_KEYS.theme, theme);
    set({ theme });
  },
}));
