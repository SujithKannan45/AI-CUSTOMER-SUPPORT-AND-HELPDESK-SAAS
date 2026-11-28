import type { Transition, Variants } from 'framer-motion';

/**
 * Shared motion values for the conversation surfaces (Prompt 23).
 *
 * Everything here is decoration layered on top of a fully usable static
 * interface: every transition is short (≤ 200ms), transforms are small (≤ 8px),
 * and callers pass `prefersReducedMotion` from framer's `useReducedMotion` so
 * the animation is dropped entirely when the OS asks for reduced motion. No
 * state, layout or focus behaviour depends on an animation completing.
 */

/** The design system's standard easing (`--ease-standard` in global.css). */
export const STANDARD_EASE: [number, number, number, number] = [0.2, 0, 0, 1];

export const QUICK_TRANSITION: Transition = { duration: 0.16, ease: STANDARD_EASE };

export const PANEL_TRANSITION: Transition = { duration: 0.2, ease: STANDARD_EASE };

/** Message bubbles: a short rise + fade as they are appended. */
export function messageVariants(reduced: boolean): Variants {
  if (reduced) {
    return { hidden: { opacity: 1 }, visible: { opacity: 1 } };
  }
  return {
    hidden: { opacity: 0, y: 8 },
    visible: { opacity: 1, y: 0, transition: QUICK_TRANSITION },
  };
}

/** Conversation list rows: a subtle staggered entrance, capped so long lists stay quick. */
export function listRowVariants(reduced: boolean, index: number): Variants {
  if (reduced) {
    return { hidden: { opacity: 1 }, visible: { opacity: 1 } };
  }
  return {
    hidden: { opacity: 0, y: 4 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { ...QUICK_TRANSITION, delay: Math.min(index, 8) * 0.015 },
    },
  };
}
