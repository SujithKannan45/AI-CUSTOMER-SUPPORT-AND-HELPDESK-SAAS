/**
 * Frontend environment configuration.
 *
 * Only `VITE_*` variables are exposed to the browser by Vite — never place
 * secrets in client env vars, they ship to every user.
 *
 * API calls intentionally use same-origin paths (`/api`, `/health`) in
 * development: the Vite dev server proxies them to the API server, which
 * avoids CORS setup locally and mirrors how the app sits behind one domain
 * in production (nginx). `VITE_API_BASE_URL` overrides this when the API is
 * hosted elsewhere.
 */

function readEnv(key: string, fallback: string): string {
  const value: unknown = import.meta.env[key as keyof ImportMetaEnv];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

export const clientEnv = {
  appName: readEnv('VITE_APP_NAME', 'AI Customer Support SaaS'),
  /** Root for versioned REST calls; empty string means same origin (proxied). */
  apiBaseUrl: readEnv('VITE_API_BASE_URL', ''),
} as const;
