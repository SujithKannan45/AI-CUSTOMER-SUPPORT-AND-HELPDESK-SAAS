/** Theme vocabulary + DOM application. Framework-free so it is unit-testable. */

export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = 'light' | 'dark';

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value);
}

/** Resolves a stored preference against the OS setting. */
export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return prefersDark ? 'dark' : 'light';
  return preference;
}

/**
 * Applies the resolved theme to the document.
 * `data-theme` drives the design tokens (see styles/global.css) and
 * `color-scheme` makes native controls (scrollbars, form widgets) match.
 */
export function applyTheme(theme: ResolvedTheme, root: HTMLElement = document.documentElement): void {
  root.dataset['theme'] = theme;
  root.style.colorScheme = theme;
}
