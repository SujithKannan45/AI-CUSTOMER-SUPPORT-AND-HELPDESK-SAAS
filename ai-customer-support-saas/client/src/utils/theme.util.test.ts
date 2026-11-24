import { describe, expect, it } from 'vitest';
import { applyTheme, isThemePreference, resolveTheme } from './theme.util';

describe('theme utilities', () => {
  it('resolves an explicit preference regardless of the OS setting', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('follows the OS setting for the system preference', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('narrows stored values safely', () => {
    expect(isThemePreference('dark')).toBe(true);
    expect(isThemePreference('system')).toBe(true);
    expect(isThemePreference('solarized')).toBe(false);
    expect(isThemePreference(null)).toBe(false);
  });

  it('applies the theme to an element', () => {
    const root = document.createElement('div');

    applyTheme('dark', root);
    expect(root.dataset['theme']).toBe('dark');
    expect(root.style.colorScheme).toBe('dark');

    applyTheme('light', root);
    expect(root.dataset['theme']).toBe('light');
    expect(root.style.colorScheme).toBe('light');
  });
});
