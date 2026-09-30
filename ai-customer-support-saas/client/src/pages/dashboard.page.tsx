import type { JSX } from 'react';
import { motion } from 'framer-motion';
import { ClientStatusCard } from '@/app/status-card.component';

/** Application landing surface. Deliberately data-free until real features land. */
export function DashboardPage(): JSX.Element {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <motion.section
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        className="rounded-xl border border-ink-200 bg-white p-8 shadow-sm"
      >
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Welcome</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-600">
          This is the foundation of your AI customer support platform. Authentication,
          workspaces, tickets, conversations, the knowledge base, and AI assistance arrive
          phase by phase on top of this architecture.
        </p>
      </motion.section>

      <section aria-label="System status" className="grid gap-4 sm:grid-cols-2">
        <ClientStatusCard />
      </section>
    </div>
  );
}
