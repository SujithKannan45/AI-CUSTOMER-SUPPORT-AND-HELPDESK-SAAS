import type { JSX, ReactNode } from 'react';
import { BookOpenCheck, MessagesSquare, ShieldCheck, Sparkles } from 'lucide-react';
import { BrandMark } from '@/components/common/brand-mark';

export interface AuthShellProps {
  title: string;
  description: string;
  children: ReactNode;
  /** Optional utilities rendered in the top-right corner (e.g. theme toggle). */
  actions?: ReactNode;
}

const HIGHLIGHTS = [
  {
    icon: MessagesSquare,
    title: 'Tickets and conversations together',
    copy: 'One queue for customer requests, live chat and email follow-ups.',
  },
  {
    icon: BookOpenCheck,
    title: 'Answers grounded in your content',
    copy: 'The AI agent replies from the knowledge base you publish — with citations.',
  },
  {
    icon: Sparkles,
    title: 'Human handoff when it counts',
    copy: 'Escalations keep the full context and land with the right teammate.',
  },
] as const;

/**
 * Public authentication layout.
 *
 * Desktop: product panel + form column. Mobile: compact brand header and a
 * single-column form. No large gradients, no animation — just the design
 * system's surfaces, type scale and spacing.
 */
export function AuthShell({ title, description, children, actions }: AuthShellProps): JSX.Element {
  return (
    <div className="min-h-dvh bg-background">
      <div className="mx-auto grid min-h-dvh w-full max-w-6xl lg:grid-cols-[1.05fr_1fr]">
        <aside
          aria-label="About the product"
          className="hidden flex-col justify-between border-r border-border bg-surface-subtle px-10 py-12 lg:flex"
        >
          <BrandMark />

          <div className="max-w-sm">
            <h2 className="text-2xl font-semibold leading-snug tracking-tight text-foreground">
              Support that answers fast, then knows when to hand over.
            </h2>
            <p className="mt-3 text-sm leading-6 text-muted">
              A multi-tenant helpdesk for teams that want AI doing the first pass without losing the
              human touch.
            </p>

            <ul className="mt-8 space-y-5">
              {HIGHLIGHTS.map(({ icon: Icon, title: highlightTitle, copy }) => (
                <li key={highlightTitle} className="flex gap-3">
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-primary">
                    <Icon aria-hidden className="h-4 w-4" />
                  </span>
                  <span>
                    <span className="block text-sm font-medium text-foreground">{highlightTitle}</span>
                    <span className="mt-0.5 block text-xs leading-5 text-muted">{copy}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <p className="flex items-center gap-2 text-xs text-muted">
            <ShieldCheck aria-hidden className="h-4 w-4 text-success" />
            Workspace access is always verified by the API — never by the browser.
          </p>
        </aside>

        <div className="flex min-w-0 flex-col px-4 py-6 sm:px-8 lg:px-12">
          <div className="flex items-center justify-between gap-3">
            <BrandMark className="lg:hidden" />
            {actions !== undefined ? <div className="ml-auto flex items-center gap-1">{actions}</div> : null}
          </div>

          <main className="flex flex-1 items-center justify-center py-10">
            <div className="w-full max-w-sm">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
              <p className="mt-1.5 text-sm leading-6 text-muted">{description}</p>
              <div className="mt-7">{children}</div>
            </div>
          </main>

          <p className="text-center text-xs text-muted">
            Protected by workspace membership checks on every request.
          </p>
        </div>
      </div>
    </div>
  );
}
