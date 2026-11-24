import { useEffect, type JSX, type ReactNode } from 'react';
import { useTheme } from '@/hooks/use-theme';
import { applyTheme } from '@/utils/theme.util';

/**
 * Keeps the document in sync with the theme preference.
 *
 * The first paint is set by the inline script in `index.html` (no flash for
 * dark-mode users); this provider takes over for preference and OS changes.
 */
export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const { resolved } = useTheme();

  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  return <>{children}</>;
}
