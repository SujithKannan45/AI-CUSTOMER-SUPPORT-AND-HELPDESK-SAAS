import type { JSX, ReactNode } from 'react';
import { cn } from '@/utils/cn.util';

/**
 * Optional entrance motion for route content.
 *
 * One short fade/rise, never a choreography — implemented with the CSS
 * `animate-page-enter` keyframes (global.css) so no animation library is
 * imported by the shell. `prefers-reduced-motion: reduce` collapses the
 * animation globally, so this component renders the same content either way.
 */
export function PageTransition({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={cn('animate-page-enter', className)}>{children}</div>;
}
