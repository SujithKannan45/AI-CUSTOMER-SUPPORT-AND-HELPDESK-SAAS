/**
 * Central route table.
 *
 * Paths are declared here so guards, navigation and pages never hard-code
 * strings. Feature routes (tickets, conversations, knowledge base, analytics,
 * settings) are added here as their prompts land — they mount inside the
 * protected `AppLayout` subtree.
 */
export const ROUTES = {
  root: '/',
  login: '/login',
  dashboard: '/dashboard',
} as const;

export type AppRoute = (typeof ROUTES)[keyof typeof ROUTES];
