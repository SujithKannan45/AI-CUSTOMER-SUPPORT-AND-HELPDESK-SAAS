import {
  AlertTriangle,
  BarChart3,
  BookOpen,
  LayoutDashboard,
  MessagesSquare,
  Settings,
  Sparkles,
  Ticket,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { ROUTES } from '@/app/routes/route-paths';

export interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** False until the owning prompt ships; the shell never links to a dead route. */
  readonly enabled: boolean;
}

export interface NavSection {
  readonly label: string;
  readonly items: readonly NavItem[];
}

/**
 * Navigation map for the whole product. Deliberately complete rather than
 * built per page: future prompts only flip `enabled` and add their route.
 */
export const NAV_SECTIONS: readonly NavSection[] = [
  {
    label: 'Overview',
    items: [{ to: ROUTES.dashboard, label: 'Dashboard', icon: LayoutDashboard, enabled: true }],
  },
  {
    label: 'Support',
    items: [
      { to: '/tickets', label: 'Tickets', icon: Ticket, enabled: false },
      { to: '/conversations', label: 'Conversations', icon: MessagesSquare, enabled: false },
      { to: '/customers', label: 'Customers', icon: Users, enabled: false },
      { to: '/escalations', label: 'Escalations', icon: AlertTriangle, enabled: false },
    ],
  },
  {
    label: 'Knowledge',
    items: [{ to: '/knowledge-base', label: 'Knowledge base', icon: BookOpen, enabled: false }],
  },
  {
    label: 'Workspace',
    items: [
      { to: '/analytics', label: 'Analytics', icon: BarChart3, enabled: false },
      { to: '/ai', label: 'AI assistant', icon: Sparkles, enabled: false },
      { to: '/settings', label: 'Settings', icon: Settings, enabled: false },
    ],
  },
];
