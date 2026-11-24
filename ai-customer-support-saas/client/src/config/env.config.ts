/**
 * Frontend environment configuration.
 *
 * Only `VITE_*` variables are exposed to the browser by Vite — never place
 * secrets in client env vars, they ship to every user.
 *
 * API calls intentionally use same-origin paths (`/api/v1/...`, `/health`) in
 * development: the Vite dev server proxies them to the API server, which
 * avoids CORS setup locally and mirrors how the app sits behind one domain in
 * production (nginx). `VITE_API_BASE_URL` overrides the origin when the API is
 * hosted elsewhere.
 */

function readEnv(key: string, fallback: string): string {
  const value: unknown = import.meta.env[key as keyof ImportMetaEnv];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function readNumberEnv(key: string, fallback: number): number {
  const raw = readEnv(key, '');
  const parsed = Number(raw);
  return raw.length > 0 && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Normalizes `VITE_API_BASE_URL` to a bare origin (no trailing slash).
 * Older deployments set it to `http://host:8000/api/v1`; the API path is part
 * of every request path now, so a trailing `/api/v1` would be duplicated.
 */
function normalizeOrigin(value: string): string {
  return value.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
}

export const clientEnv = {
  appName: readEnv('VITE_APP_NAME', 'AI Customer Support SaaS'),
  /** API origin. Empty string = same origin (dev proxy / nginx). */
  apiOrigin: normalizeOrigin(readEnv('VITE_API_BASE_URL', '')),
  /** Versioned REST prefix — mirrors `API_PREFIX` on the server. */
  apiPrefix: '/api/v1',
  /** Refresh endpoint; scoped HttpOnly cookie path on the server. */
  authRefreshPath: '/api/v1/auth/refresh',
  /** Hard per-request timeout (ms) so a hung API never freezes the UI. */
  requestTimeoutMs: readNumberEnv('VITE_API_TIMEOUT_MS', 15_000),
} as const;
