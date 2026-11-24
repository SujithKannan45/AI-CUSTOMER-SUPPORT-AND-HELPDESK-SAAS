import { useUiStore } from '@/store/ui.store';
import { resolveTheme, type ResolvedTheme, type ThemePreference } from '@/utils/theme.util';
import { useMediaQuery } from './use-media-query';

export interface ThemeContextValue {
  /** User preference ('system' follows the OS). */
  preference: ThemePreference;
  /** The theme actually painted right now. */
  resolved: ResolvedTheme;
  setTheme: (preference: ThemePreference) => void;
}

/** Reads the theme preference and resolves it against the OS setting. */
export function useTheme(): ThemeContextValue {
  const preference = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');

  return { preference, resolved: resolveTheme(preference, prefersDark), setTheme };
}
