import { useState, type JSX } from 'react';
import { cn } from '@/utils/cn.util';

const SIZES = {
  xs: 'h-6 w-6 text-[10px]',
  sm: 'h-8 w-8 text-xs',
  md: 'h-9 w-9 text-sm',
  lg: 'h-12 w-12 text-base',
} as const;

export type AvatarSize = keyof typeof SIZES;

export interface AvatarProps {
  name: string;
  src?: string;
  size?: AvatarSize;
  className?: string;
  /** Optional accessible name. Omit when the name is already visible next to it. */
  label?: string;
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return '?';
  const first = words[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1] ?? '') : '';
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

/** Round user/workspace marker with an initials fallback. */
export function Avatar({ name, src, size = 'md', className, label }: AvatarProps): JSX.Element {
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = src !== undefined && src.length > 0 && !imageFailed;

  return (
    <span
      role={label !== undefined ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-surface-hover font-semibold text-muted',
        SIZES[size],
        className,
      )}
    >
      {showImage ? (
        <img
          src={src}
          alt=""
          className="h-full w-full object-cover"
          onError={() => {
            setImageFailed(true);
          }}
        />
      ) : (
        <span>{initialsOf(name)}</span>
      )}
    </span>
  );
}
