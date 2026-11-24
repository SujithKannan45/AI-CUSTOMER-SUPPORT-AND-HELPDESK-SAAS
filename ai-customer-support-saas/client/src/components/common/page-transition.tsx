import type { JSX, ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

/**
 * Optional entrance motion for route content.
 *
 * One short fade/rise, never a choreography: motion is decoration, so it is
 * skipped entirely when the user prefers reduced motion (and framer-motion's
 * `useReducedMotion` also reacts to the OS setting changing at runtime).
 */
export function PageTransition({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  const prefersReducedMotion = useReducedMotion();

  if (prefersReducedMotion === true) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  );
}
