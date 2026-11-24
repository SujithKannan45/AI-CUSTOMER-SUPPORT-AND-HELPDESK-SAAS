import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

/**
 * jsdom does not implement `matchMedia`; the theme hook subscribes to it on
 * every render, so tests need a stable stub that always reports "light".
 */
if (typeof window.matchMedia !== 'function') {
  const stub = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as (query: string) => MediaQueryList;

  Object.defineProperty(window, 'matchMedia', { writable: true, value: stub });
}

/** jsdom has no layout engine. */
if (typeof window.HTMLElement.prototype.scrollIntoView !== 'function') {
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
}
