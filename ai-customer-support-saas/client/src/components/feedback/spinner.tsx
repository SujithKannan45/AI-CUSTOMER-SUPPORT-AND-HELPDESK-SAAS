import { Loader2 } from 'lucide-react';
import { cn } from '@/utils/cn.util';
import type { JSX } from 'react';

export function Spinner({ className }: { className?: string }): JSX.Element {
  return <Loader2 aria-label="Loading" role="status" className={cn('h-6 w-6 animate-spin text-brand-600', className)} />;
}
