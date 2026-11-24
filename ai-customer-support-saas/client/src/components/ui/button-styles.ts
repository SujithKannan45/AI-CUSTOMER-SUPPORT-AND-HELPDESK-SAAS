import { cva, type VariantProps } from 'class-variance-authority';

/**
 * Button style contract, kept separate from the component so link-styled
 * buttons (`ButtonLink`) and future composed controls share one source.
 *
 * Colours come from semantic tokens only (`bg-primary`, `text-muted`, …), so
 * every variant repaints correctly in both themes.
 */
export const buttonVariants = cva(
  'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-colors duration-150 ease-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary-hover',
        secondary: 'bg-surface-hover text-foreground hover:bg-border',
        outline: 'border border-border-strong bg-surface text-foreground hover:bg-surface-hover',
        ghost: 'text-muted hover:bg-surface-hover hover:text-foreground',
        danger: 'bg-danger text-danger-foreground hover:opacity-90',
      },
      size: {
        sm: 'h-8 gap-1.5 px-3 text-xs',
        md: 'h-9 px-3.5 text-sm',
        lg: 'h-11 px-5 text-sm',
        icon: 'h-9 w-9 p-0',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export type ButtonStyleProps = VariantProps<typeof buttonVariants>;
