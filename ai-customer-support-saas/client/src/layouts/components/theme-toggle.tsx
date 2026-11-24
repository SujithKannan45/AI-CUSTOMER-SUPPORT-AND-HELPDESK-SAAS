import type { JSX } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { useTheme } from '@/hooks/use-theme';

/** One-click light/dark switch; 'system' stays available through `useTheme`. */
export function ThemeToggle(): JSX.Element {
  const { resolved, setTheme } = useTheme();
  const next = resolved === 'dark' ? 'light' : 'dark';
  const label = `Switch to ${next} theme`;

  return (
    <Tooltip content={label} side="bottom">
      <Button variant="ghost" size="icon" aria-label={label} onClick={() => setTheme(next)}>
        {resolved === 'dark' ? <Sun aria-hidden className="h-4 w-4" /> : <Moon aria-hidden className="h-4 w-4" />}
      </Button>
    </Tooltip>
  );
}
