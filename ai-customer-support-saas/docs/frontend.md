# Frontend architecture, design system, auth UI & dashboard (Prompts 19–21)

This document describes the React application as it exists today. It is a
maintainer's guide, not a roadmap: every path, token and behaviour named here is
implemented in `client/`. Prompt 20 added the real sign-in, password-recovery,
session, sign-out and workspace-selection surfaces on top of the Prompt 19
foundation. Prompt 21 replaced the dashboard placeholder with a live workspace
analytics dashboard built on the Prompt 18 API.

The frontend is a **React 19 + TypeScript (strict) SPA** built with Vite,
routed by React Router 7's data router, styled with Tailwind CSS 4 design
tokens, with Zustand for the few genuinely global pieces of state and Vitest +
Testing Library for tests.

---

## 1. Principles

1. **Feature-first modules.** Domain code lives in `src/features/<domain>`;
   shared presentation lives in `src/components`. A feature may import
   `components/`, `hooks/`, `services/`, `utils/` — never another feature's
   internals.
2. **The API is the authority.** The client never decides authorization. A
   workspace id in a URL is a *routing* input; the server resolves membership
   from the database for every request.
3. **Two kinds of state, kept apart.** Server data is fetched per surface
   through typed services; only UI/session/tenant-selection state is global.
4. **Tokens, not colours.** Components reference semantic tokens
   (`bg-surface`, `text-muted`, `border-border`); primitives (`brand-*`,
   `ink-*`) exist for the token layer, not for ad-hoc use.
5. **Accessibility is part of "done".** Labelled controls, keyboard paths,
   visible focus, `aria-live` for async feedback, reduced-motion support.
6. **No fake data, no fake sessions.** Placeholders are labelled as such; the
   shell renders only what the API actually returned.

---

## 2. Directory structure

```
client/
├── index.html                  # theme bootstrap (no flash), meta, root element
├── vite.config.ts              # dev proxy /api + /health, '@' alias
├── vitest.config.ts            # jsdom + setup file (test-only config)
└── src/
    ├── app/
    │   ├── App.tsx             # ErrorBoundary → providers → router
    │   ├── router.tsx          # route table, lazy page splitting
    │   ├── providers/          # app-providers, theme.provider, toast.provider
    │   ├── guards/             # require-auth (session), require-workspace (tenant)
    │   └── routes/             # route-paths (single source for path strings)
    ├── components/
    │   ├── ui/                 # design system (see §4)
    │   ├── common/             # page-header, page-transition
    │   ├── navigation/         # breadcrumbs
    │   └── feedback/           # states, spinner, error-boundary
    ├── config/env.config.ts    # the only reader of import.meta.env
    ├── features/
    │   ├── auth/               # session store, validation, errors, sign-out hook,
    │   │                       # sign-in/forgot-password/auth-shell components
    │   ├── workspace/          # types, service, store, hooks, create dialog
    │   ├── analytics/          # Prompt 21 types, service, date model, hook, charts
    │   ├── dashboard/          # foundation-only dashboard components
    │   └── notifications/      # unread-count service
    ├── hooks/                  # use-debounce, use-media-query, use-theme, use-toast
    ├── layouts/                # app-layout + sidebar/header/workspace-switcher/…
    ├── pages/                  # login, reset-password, workspace picker, dashboard, 404
    ├── services/               # http-client, auth-token store, health
    ├── store/                  # ui.store (sidebar + theme preference)
    ├── styles/global.css       # design tokens, base layer, z-index utilities
    ├── test/setup.ts           # jest-dom, cleanup, jsdom gaps
    ├── types/                  # shared API envelopes and health contracts
    └── utils/                  # cn, storage, theme helpers
```

Rules of thumb:

- A file over ~250 lines is a signal to split, not to keep growing.
- `pages/` holds route entry points only; page-specific pieces go in
  `features/<domain>/components/`.
- Pure helpers go in `utils/` and stay framework-free so they can be unit
  tested without React.

---

## 3. Design tokens and theming

Tokens live in `src/styles/global.css`. Two layers:

**Primitives (`@theme`)** — fixed values that never change with the theme:

| Group | Tokens |
| --- | --- |
| Brand | `--color-brand-50 … 900` (indigo) |
| Neutral | `--color-ink-50 … 950` |
| Typography | `--font-sans`, `--font-mono` |
| Spacing | `--spacing: 0.25rem` (every spacing utility is a 4px multiple) |
| Radius | `--radius-sm 4px`, `md 6px`, `lg 8px`, `xl 12px`, `2xl 16px` |
| Motion | `--ease-standard`, `--ease-emphasized` |
| Elevation | `--shadow-card`, `--shadow-popover`, `--shadow-modal` |

**Semantics (`@theme inline` → CSS variables)** — the tokens components
consume, declared once per theme:

| Token | Utility examples | Meaning |
| --- | --- | --- |
| `background` | `bg-background` | page canvas |
| `surface`, `surface-subtle`, `surface-hover` | `bg-surface` | cards, panels, hover states |
| `border`, `border-strong` | `border-border` | hairline vs. control borders |
| `foreground`, `muted` | `text-foreground`, `text-muted` | primary vs. secondary text |
| `primary`, `primary-hover`, `primary-soft`, `primary-foreground` | `bg-primary` | brand actions |
| `success`, `warning`, `danger`, `info` (+ `-soft`, `-strong`, `danger-foreground`) | `text-danger`, `bg-warning-soft` | status language |
| `ring` | `ring-ring` | focus ring |
| `overlay` | `bg-overlay` | modal/drawer scrim |

`@theme inline` keeps the generated utility pointing at `var(--surface)`, so
swapping one attribute repaints the whole app.

**Theme switching.** `data-theme="light|dark"` on `<html>`:

1. `index.html` runs a tiny inline script before first paint, reading the
   stored preference (`localStorage['ui-theme']`) and the OS setting, so
   dark-mode users never see a white flash.
2. `ThemeProvider` (`app/providers/theme.provider.tsx`) keeps `data-theme` and
   `color-scheme` in sync using `useTheme()`, which resolves the stored
   preference against `prefers-color-scheme`.
3. `ThemeToggle` in the header flips light/dark; `'system'` remains the stored
   default and is available through `useTheme().setTheme`.

**Z-index layers** are tokens too (`--z-base`, `-sticky 20`, `-overlay 30`,
`-drawer 40`, `-modal 50`, `-toast 60`, `-tooltip 70`) exposed as `z-sticky`,
`z-drawer`, `z-modal`, `z-toast`, `z-tooltip` utilities. Never write a raw
`z-[…]`.

**Motion.** Two easings and three shadows, no more. Global CSS disables
transition/animation duration under `prefers-reduced-motion: reduce`, and
`PageTransition` skips its animation entirely when the user asks for reduced
motion.

---

## 4. Component foundation (`components/ui`)

All components are typed with explicit props, forward refs where a consumer may
need the DOM node, and accept `className` that is merged (not replaced) through
`cn()` (`clsx` + `tailwind-merge`).

| Component | Notes |
| --- | --- |
| `Button`, `ButtonLink` | `variant` (primary/secondary/outline/ghost/danger), `size` (sm/md/lg/icon), `isLoading` (spinner + disabled + `aria-busy`). `ButtonLink` renders a real anchor with button styling. |
| `Input`, `Textarea`, `Select` | `invalid` prop sets `aria-invalid` and danger styling; `Select` is the native control (mobile pickers, screen readers) with a decorative chevron. |
| `Checkbox`, `Switch` | Associated labels; `Switch` is `role="switch"` with `aria-checked` and Space/Enter support. |
| `Field` + `FieldLabel`, `FieldDescription`, `FieldError` | Label/description/error composition. Use `fieldDescribedBy(id, {…})` from `field-ids.ts` for `aria-describedby`. |
| `Badge` | `tone` (neutral/brand/success/warning/danger/info) × `appearance` (soft/solid/outline), optional `dot`. Always carries text, so colour is never the only signal. |
| `Alert` | Inline form-level feedback: `tone` (error/success/warning/info), optional title, `role="alert"` for errors and `role="status"` otherwise. |
| `Avatar` | Initials fallback, `onError` fallback, sizes xs–lg, decorative unless `label` is given. |
| `Tooltip` | Hover + keyboard focus, Escape dismisses, linked with `aria-describedby`. Short hints only. |
| `Dropdown` | WAI-ARIA menu button: Arrow/Home/End navigation, Escape restores focus, outside click closes, `header` slot for identity. |
| `Modal`, `ConfirmDialog` | Portal, `aria-modal`, labelled by title, focus moved in and restored, Tab trapped, Escape closes, body scroll locked. `ConfirmDialog` is the required path for destructive actions. |
| `Card` (+ `CardHeader`, `CardBody`, `CardFooter`, `CardTitle`, `CardDescription`) | The one surface primitive. |
| `Separator` | Horizontal (optional label) or vertical; `role="separator"`. |
| `Tabs` | Controlled or uncontrolled, roving tabindex, Arrow/Home/End, labelled panels. |
| `Table` (+ header/body/row/head/cell/`TableMessageRow`) | Scrollable container so wide tables never break the page; `TableMessageRow` for empty/loading rows. |
| `Pagination` | Bounded page window, `aria-current="page"`, disabled edges, "Showing x–y of z" live summary. Server-side pagination only. |
| `SearchInput` | `role="search"` form, labelled input, clear button, `onSubmit` for explicit search. Pair with `useDebounce` for live typing. |
| `Skeleton`, `SkeletonText`, `SkeletonTable` | Decorative placeholders (`aria-hidden`); the containing region announces loading. |
| `ToastViewport` + `ToastProvider` + `useToast()` | Queue of max 4, auto-dismiss timers cleared on unmount, `aria-live="polite"`, per-toast dismiss. |

Feedback states (`components/feedback`): `LoadingState`, `ErrorState` (with
retry), `EmptyState`, `Spinner`, and the root `ErrorBoundary`.

**When adding a component:** check whether an existing one can take a variant
instead; keep raw colour values out; add keyboard behaviour in the component
(not the page); cover the prop contract with a test.

---

## 5. Forms and validation

No form library and no client validation library was added. The pattern:

```tsx
<Field
  id="email"
  label="Email"
  description="We reply to this address."
  error={errors.email}
  required
>
  <Input
    id="email"
    type="email"
    required
    invalid={errors.email !== undefined}
    aria-describedby={fieldDescribedBy('email', { description: '…', error: errors.email })}
  />
</Field>
```

- The **server is the validation authority** (Zod schemas + 422 field details).
  `HttpApiError.isValidationError` and `error.details` carry them.
  `utils/api-error.util.ts#firstFieldError` reads one field's message (used by
  workspace creation).
- Auth forms additionally mirror only the rules needed to fail fast and focus
  the right control (`features/auth/validation.ts`): email format, required
  password, and the documented reset-password policy. The mirrors must stay in
  step with `server/src/modules/auth/auth.validation.ts`.
- Required fields are marked visually (`*`) and announced (“(required)”).
- Submit buttons use `Button isLoading` so double submits are impossible while
  a request is in flight.

---

## 6. Application layout

`AppLayout` (`layouts/app-layout.tsx`) is the authenticated shell:

- **Desktop (≥1024px):** sticky, full-height 256px sidebar; sticky 56px header;
  content centred in `max-w-7xl`.
- **Tablet:** the sidebar stays static; header utilities collapse first.
- **Mobile:** the sidebar becomes a drawer with a scrim, a labelled close
  control, Escape support, route-change auto-close and proper touch targets
  (36–40px controls).
- **Skip link** to `#main-content` is the first focusable element.
- `Sidebar` shows brand, `WorkspaceSwitcher` (real `GET /workspaces` data,
  persisted selection), grouped navigation from `nav-items.ts` and a build
  footer. Routes that do not exist yet are rendered as `aria-disabled` text —
  the shell never links to a dead route.
- `Header` shows the active workspace, `ThemeToggle`, `NotificationButton`
  (real unread count, non-interactive until the inbox prompt lands) and
  `UserMenu` (identity, role badge, wired sign-out).
- `PageHeader` + `Breadcrumbs` give every page the same title rhythm.

No horizontal overflow: wide content (tables) scrolls inside its own
container.

---

## 7. Routing and guards

`app/routes/route-paths.ts` is the single source of path strings. The router
(`app/router.tsx`):

| Path | Access | Notes |
| --- | --- | --- |
| `/login` | public | real sign-in form; authenticated visitors are redirected away |
| `/reset-password?email&token` | public | password-reset form consuming the emailed token |
| `/workspaces/select` | session only | workspace picker / empty-workspace state + creation |
| `/`, `/dashboard` | session + workspace | `RequireAuth` → `RequireWorkspace` → `AppLayout` → lazy `DashboardPage` (Prompt 21 analytics dashboard) |
| `*` | session + workspace | not-found page inside the shell |

`RequireAuth` (`app/guards/require-auth.tsx`):

1. Runs `session.bootstrap()` once per app load: silent refresh-cookie exchange
   plus `GET /api/v1/auth/me`.
2. Renders `LoadingState` while resolving — never a flash of protected content.
3. Redirects to `/login` (carrying `state.from`) when the session is rejected.
4. Renders a **retryable error** when the API is unreachable — a network
   failure is not treated as “logged out”.
5. Drops the session and redirects when a later request reports the session is
   gone (`subscribeToAuthFailure`).

`RequireWorkspace` (`app/guards/require-workspace.tsx`) runs the workspace load
through `useWorkspaceBootstrap()` and adds a fourth state beyond auth:

- loading → status screen; load error → retryable error (never misreported as
  “no workspaces”);
- ready with no active membership → redirect to `/workspaces/select`;
- ready with an active workspace → render the shell.

`/workspaces/select` deliberately sits **outside** the workspace gate so an
account with zero memberships still has a real, protected destination.

Return-to is stored as router state (`state.from`) by `RequireAuth` and read by
`features/auth/redirect.ts`. Only same-origin absolute paths are accepted and
`/login` itself is rejected, so history state cannot be used as an open
redirect.

To add a route in a later prompt: add the path to `route-paths.ts`, add the
page under `pages/` (or a feature’s pages), insert a child route inside the
`AppLayout` subtree with `lazy()`, then flip the matching `nav-items.ts`
entry to `enabled: true`.

---

## 8. Authentication UI (Prompt 20)

### Routes and components

| Route | Page | Feature components |
| --- | --- | --- |
| `/login` | `pages/login.page.tsx` | `AuthShell`, `SignInForm`, `ForgotPasswordDialog`, `PasswordInput` |
| `/reset-password` | `pages/reset-password.page.tsx` | `AuthShell`, `PasswordInput` |
| — | — | `useSignOut` (shared by user menu and picker) |

`AuthShell` is the balanced two-column public layout: product identity and
three capability statements on the left (desktop), form column on the right;
single column with a compact brand header on mobile. No gradients, no
decorative animation, theme toggle in the form column.

### Sign-in flow

1. The page calls `session.bootstrap()` on mount. While it resolves, the panel
   shows “Checking your session…” instead of a form that could race it.
2. An already-authenticated visitor is redirected to `state.from` or
   `/dashboard` — the login screen is never shown unnecessarily.
3. `SignInForm` trims the email, never trims/rewrites the password, and blocks
   the request when either field is missing or the email is malformed, focusing
   the first invalid field.
4. `POST /api/v1/auth/login` returns `{ user, tokens }`; the access token goes
   to the in-memory token store via `startSession`, never to storage.
5. The form routes to `state.from` or `/dashboard`. `RequireWorkspace` then
   loads the tenant list and sends an account with no active membership to
   `/workspaces/select` — the picker decision lives in one place.
6. A submit guard (ref + `isLoading`/disabled) prevents duplicate requests.

### Validation and errors

`features/auth/validation.ts` mirrors the login contract: required email with
the same `EMAIL_PATTERN` as the server, ≤254 chars; required password ≤128
chars. Passwords are sent unchanged.

`features/auth/auth.errors.ts` maps failures to safe copy and never prints a
response body, stack, URL or token:

| Failure | Copy |
| --- | --- |
| 401 | “Email or password is incorrect.” (uniform, matches server anti-enumeration) |
| 403 | suspended / invitation-not-accepted / no access |
| 422 | “Check your email and password, then try again.” |
| 429 | too many attempts, wait a few minutes |
| 5xx | service temporarily unavailable |
| status 0 | the client's own network/timeout message |

Field errors are wired with `Field` + `fieldDescribedBy`, so `aria-describedby`
links the control to its error and the error is an `alert`. The form-level
failure uses `<Alert tone="error">` (`role="alert"`).

### Password recovery

The backend really implements recovery, so the UI does too:

- `POST /api/v1/auth/forgot-password` via a dialog on the login page. The
  confirmation is deliberately conditional (“If an account exists for …”), the
  same anti-enumeration shape the server returns.
- `POST /api/v1/auth/reset-password` on `/reset-password?email&token`. The page
  first validates the email and the 64-hex token shape, then applies the
  server's password policy (8–128 chars, letter + digit) and confirmation
  match. On success it returns to `/login` with a one-time success notice.
- Registration and email verification screens are **not** part of Prompt 20
  (see §16).

### Session lifecycle

`SessionStatus` is one of `idle | loading | authenticated | anonymous | error`:

- `bootstrap()` skips while loading/authenticated, unblocks the refresh guard,
  and calls `GET /auth/me` (which transparently performs the single-flight
  `POST /auth/refresh` once on 401).
- 401 → `anonymous` (normal logged-out path); token cleared.
- transport/5xx → `error` with a retry action; the user is **not** signed out.
- `startSession` sets the in-memory token and `authenticated`.
- `subscribeToAuthFailure` (fired when a later request loses its session) calls
  `reset()` so protected UI disappears immediately.

There is exactly one session store; the guard and login page both read it.

### Sign-out

`useSignOut()`:

1. calls `POST /api/v1/auth/logout` (which revokes the refresh token and clears
   the HttpOnly cookie);
2. always clears the access token and session state, even when the request
   fails; the app-level `SessionSyncProvider` clears the workspace list and the
   persisted workspace selection as soon as the status becomes `anonymous`
   (the auth and workspace features do not import each other's stores);
3. returns `{ remoteRevoked }`; on failure a warning toast says the session
   ended on this device but server-side revocation could not be confirmed —
   the UI never claims the server session was invalidated;
4. navigates to `/login` with `replace`.

## 9. Workspace UI (Prompt 20)

### Workspace picker (`/workspaces/select`)

A protected, standalone screen (brand, user name/email, theme toggle, sign out)
with explicit states: skeleton while loading; retryable error; empty state with
“Create workspace”; and the membership list. Each row shows only real API data:
workspace name, slug, the caller's role and membership join date, with a
“Current” marker. Selecting a row calls `setActive(id)` and navigates to the
dashboard.

### Workspace gate and switcher

- `RequireWorkspace` ensures the shell never renders with an unresolved tenant.
- `WorkspaceSwitcher` lists exactly the memberships returned by the API, shows
  the current role, and adds a real “Create workspace…” action. Switching
  updates `activeWorkspaceId` and persists it as a convenience preference.
- There is no tenant data cache yet; every future tenant-scoped query must key
  its fetch on `activeWorkspaceId` (and reset on change) so a previous
  workspace's rows can never be shown after a switch. Today the dashboard
  derives everything from the store, so the header, role and workspace card
  update atomically.
- `setActive` ignores ids that are not in the caller's own list; the client
  cannot grant itself access, and the server re-checks membership on every
  request regardless.

### Creation

`POST /api/v1/workspaces` is supported by the backend and used by the real
dialog (name 3–100 chars, sent trimmed). The server makes the authenticated
caller the owner; the client never sends an owner id. The new workspace is
added to the list and made active **only after** the response arrives; 409
(name/slug already exists), 422 field details, 429 and 5xx have dedicated copy.

### Invitations / member management

The backend currently exposes only create/list/detail/update workspace routes —
there are no invite or member-management endpoints. No invitation UI, fake
member records or simulated emails were created. That capability needs a
backend phase first.

## 10. Admin dashboard (Prompt 21)

### Route and components

The existing `/dashboard` placeholder is now the real workspace dashboard:

| Piece | Location | Responsibility |
| --- | --- | --- |
| `DashboardPage` | `pages/dashboard.page.tsx` | Owns the date selection and the page-level state switch (loading / error / forbidden / empty / data) |
| `DashboardHeader` | `features/analytics/components/dashboard-header.tsx` | Title, description, current workspace + role, preset/custom range control, refresh |
| `KpiGrid`, `KpiCard` | `…/kpi-grid.tsx` | Six KPI tiles mapped 1:1 to API fields |
| `TicketTrendChart` | `…/ticket-trend-chart.tsx` | Responsive inline-SVG created/resolved trend, hover + keyboard inspection |
| `StatusDistribution` | `…/status-distribution.tsx` | Current ticket mix from `byStatus` |
| `ResolutionPerformance` | `…/resolution-performance.tsx` | Backend duration and backlog metrics |
| `DashboardLoadingState`, `DashboardForbiddenState` | `…/dashboard-states.tsx` | Skeleton and 403 surfaces (reuses `EmptyState`/`ErrorState` elsewhere) |

The old `features/dashboard/components/api-status-card.tsx` still exists but is
no longer rendered: the dashboard now shows product data, not a health probe.

### Analytics endpoints consumed

All calls go through the single HTTP client and the active workspace from the
workspace store. IDs are encoded into the path; the server resolves membership
and the `analytics.view` permission on every request.

| Service method | Endpoint | Query |
| --- | --- | --- |
| `analyticsService.getOverview` | `GET /api/v1/workspaces/:id/analytics/overview` | `range`, and `from`/`to` for custom |
| `analyticsService.getTickets` | `GET …/analytics/tickets` | `range`, optional `bucket`, custom bounds |
| `analyticsService.getPerformance` | `GET …/analytics/performance` | `range`, and custom bounds |

Fields actually rendered: `tickets.total`, `createdInPeriod`, `resolvedInPeriod`,
`byStatus`; `customers.total`, `newInPeriod`; `performance.backlog.totalBacklog`,
`unassigned`; `resolutionTime.averageMs`, `medianMs`, `count`;
`firstStaffReply.averageMs`, `conversations`; the server-resolved `period` for
the window label. AI, escalation, knowledge-base and CSV-report reads are **not**
used by this dashboard (they exist in the API but are outside Prompt 21's scope).

**Scope is stated in the UI, not guessed.** The backend's `overview`/`tickets`
totals and `byStatus` counts cover all live tickets in the workspace (the
aggregation is not date-filtered); `createdInPeriod`, `resolvedInPeriod`,
durations and first-reply metrics are window-scoped. KPI hints and the status
card caption say which is which.

### Data fetching, refresh and tenant safety

`useDashboardAnalytics` (`features/analytics/use-dashboard-analytics.ts`) loads
the three reads with `Promise.all` and has no cache library:

- The hook is keyed on `workspaceId` + normalized filter. A workspace or range
  change immediately clears previously rendered data (a synchronous scope guard
  in the hook return prevents even one frame of the old tenant's numbers).
- Every load increments a request sequence; a response is applied only when its
  sequence is still current. An older workspace/range can therefore never
  overwrite the active one, even if it resolves later. `AbortController` cancels
  the request on cleanup as a best-effort optimization.
- A same-scope refresh keeps the current data visible (`refreshing`) instead of
  flashing skeletons; a scope change shows the loading skeleton.
- `refresh()` refetches all three reads; preset/custom range changes go through
  the same path.
- Errors are mapped by status only (403, 404, 429, network, 5xx); response
  bodies and request ids are never shown.

There is still no React Query: the dashboard is the only server-data surface
with overlapping-request risk today, and the sequence guard plus typed service
covers it without a new dependency. When ticket/inbox lists land, revisit that
decision centrally (see §12).

### Date ranges

Presets are exactly the backend presets: **Last 7 / 30 / 90 days**. **Custom**
is supported by the API, so it is supported here:

- Two calendar-day inputs are validated locally (both present, real dates,
  start ≤ end, ≤ 366 days). Invalid input shows an alert and never calls the
  API.
- Calendar days are converted to UTC half-open bounds: `from` at `00:00Z`,
  `to` **exclusive** at the next UTC midnight. This matches the server's
  convention and avoids boundary double-counting.
- Custom windows > 45 days request `bucket=week`, and > 180 days `bucket=month`
  so axis labels stay readable; presets use `day`. This is presentation only —
  the server still owns bucketing and zero-filling, and the chart formats labels
  with the `bucket` returned in `period`.
- The header shows the server-resolved window (`period.from`/`period.to`) and
  that analytics is UTC.

### Metrics and definitions

- KPIs: total live tickets, active backlog (`OPEN + IN_PROGRESS +
  WAITING_FOR_CUSTOMER`, as defined by the performance endpoint), created in
  period, resolved in period, average resolution time, total customers with a
  new-in-period hint.
- Durations come from the API (`resolvedAt − createdAt`, null/negative excluded
  server-side) and are formatted as `< 1 min`, `45m`, `1h 30m`, `3d 4h`. A
  server `null` renders as `—`, never a fabricated zero.
- The status chart uses the actual enum labels (Open, In progress, Waiting for
  customer, Resolved, Closed) and raw counts; bar length is relative to the
  largest status, a visual aid only.
- First staff reply is labelled as public-reply-only; customer first-response is
  explicitly reported as not measurable in this deployment.

### States and charts

- Loading: skeleton KPI/chart blocks with a `role="status"` announcement.
- Refreshing: existing data stays, header action shows progress and an
  `aria-live` notice.
- Error: retryable `ErrorState`; 403 renders the non-retryable “Analytics access
  required” surface (agents/viewers without `analytics.view`).
- Empty: a workspace with no tickets, customers or conversations shows “No
  analytics yet”; the trend shows “No ticket activity in this period” for an
  all-zero window; the status card shows “No tickets yet” when the total is 0.
- Charts are hand-built SVG (no chart dependency): responsive width via
  `ResizeObserver`, theme colours from semantic CSS variables, dashed grid,
  visible values, hover tooltips, arrow/Home/End inspection and an aria-live
  summary. Zero-filled server buckets are plotted as real zeros.

## 11. API client

`services/http-client.service.ts` is the only module that calls `fetch`.

- **Base URL:** `clientEnv.apiOrigin` + path. `apiOrigin` comes from
  `VITE_API_BASE_URL` (empty = same origin, i.e. the Vite dev proxy or nginx).
  A legacy value ending in `/api/v1` is normalised away.
- **Paths:** full and explicit, e.g. `/api/v1/workspaces/:id/tickets`.
- **Auth:** `Authorization: Bearer <accessToken>` when a token is in memory.
  `credentials: 'include'` so the HttpOnly refresh cookie travels to
  `/api/v1/auth` only (its server-side path scope).
- **Timeout:** `AbortSignal` + `VITE_API_TIMEOUT_MS` (default 15s); caller
  signals are merged, so unmounting a page cancels its request.
- **Envelope:** `{ success: true, data, requestId }` is unwrapped to `data`;
  the two health probes (which are un-enveloped) pass through.
- **401 handling:** refresh once (single-flight), retry the original request
  once with the new token. On refresh failure the token is cleared, the
  refresh attempt is blocked for the rest of the session, auth-failure
  listeners fire and an `HttpApiError` is thrown. There is no loop and no
  parallel refresh storm against the rate-limited refresh route.
- **Errors:** every failure is an `HttpApiError` with `status`, `code`,
  `details`, `requestId` and helpers (`isAuthError`, `isNetworkError`,
  `isNotFound`, `isValidationError`). `status: 0` means transport failure.

`services/auth-token.store.ts` holds the access token **in memory only** and
the refresh-block flag. Nothing sensitive is written to storage.

Feature services (`features/*/…service.ts`, `services/health.service.ts`) are
thin typed wrappers; components never build URLs.

---

## 12. State management

| State | Where | Why |
| --- | --- | --- |
| Sidebar open, theme preference | `store/ui.store.ts` (Zustand, theme persisted) | global UI, tiny, changes rarely |
| Session: status, user, bootstrap/startSession/signOut | `features/auth/auth.store.ts` (Zustand) | needed by the guard, header and every page |
| Workspace list, active workspace, create | `features/workspace/workspace.store.ts` (Zustand) | one fetch per session, read by the shell |
| Toasts | React state in `ToastProvider` | transient, owned by one subtree |
| Dashboard analytics, date window, refresh | `useDashboardAnalytics` (component state) | page-scoped, keyed on workspace + range; not global |
| Form input, open/closed UI, fetched page data | local component state | the default; do not globalise it |

Server data is fetched by the surface that needs it through a typed service.
There is **no** React Query today. The analytics dashboard uses the page-scoped
`useDashboardAnalytics` hook because its only cache concern is “never show
another tenant's data”, solved with a sequence guard. When the ticket/inbox
lists (Prompt 22+) need cross-page caching, add TanStack Query in
`AppProviders` and keep the existing services as the fetch layer — the component
API does not change.

---

## 13. Responsive & accessibility conventions

- Mobile-first utility classes; breakpoints used: `sm`, `md`, `lg`.
- Every interactive control is a real `button`/`a`/`input` with an accessible
  name; icon-only buttons always carry `aria-label`.
- Focus is always visible (`:focus-visible` ring token), never removed.
- Dialogs: focus trap, `aria-modal`, Escape, focus restoration.
- Menus/tabs: roving tabindex and arrow keys, as per WAI-ARIA.
- Async feedback: `LoadingState` (`role="status"`), `ErrorState`
  (`role="alert"`), toasts in an `aria-live` region; skeletons are
  `aria-hidden`.
- Status is communicated with text plus colour (badges always have labels).
- `prefers-reduced-motion` disables transitions and page motion.
- No horizontal page scroll at 320px; wide tables scroll within their card.

---

## 14. Tests

```bash
npm run test --workspace client      # vitest run
npm run test:watch --workspace client
```

Configuration: `client/vitest.config.ts` (jsdom, React plugin, `@` alias,
`src/test/setup.ts`). Tests live next to the code as `*.test.ts(x)`.

Covered today (125 tests, 28 files):

- `Button` — label, variants, loading/disabled, click, keyboard activation.
- `Modal` — portal/ARIA, focus in, Escape, close button, Tab containment.
- `Tabs` — default selection, click, arrow/Home/End navigation.
- `Checkbox` / `Switch` — label association, `aria-checked`, keyboard toggle.
- `Pagination` — range summary, `aria-current`, navigation calls, disabled edges.
- `Field` — label/description/error wiring, required marker, invalid input.
- `ToastProvider` — announce, dismiss, auto-dismiss.
- `http-client` — envelope unwrapping, bearer header, error mapping,
  refresh-and-retry, single-flight refresh, no refresh loop, opt-out calls,
  network error mapping.
- `RequireAuth` — authenticated render, redirect, retryable error.
- `RequireWorkspace` — shell render, no-workspace redirect, retryable load error.
- `SessionSyncProvider` — clears workspace context when the session ends and
  leaves it untouched for authenticated profile updates.
- Auth validation — required fields, email format/trim, password not trimmed,
  reset-password policy and confirmation.
- Session store — bootstrap success/401/network, in-memory token only, sign-out
  clearing session + workspace with honest `remoteRevoked`.
- `SignInForm` — labels, required/format validation, password visibility,
  successful login (with return-to/workspace routing), invalid credentials,
  network failure, duplicate-submit guard, no token/password in localStorage.
- `LoginPage` — anonymous form, restored-session redirect, `state.from`.
- `ForgotPasswordDialog` / `ResetPasswordPage` — validation, success copy,
  token contract, failure copy, initial focus.
- Workspace store — stored-selection restore/fallback, error, foreign-id
  no-op, creation activation, reset.
- Workspace picker / create dialog / `UserMenu` — loading, empty, error, list,
  selection, creation validation/conflict, sign-out success and failure.
- Analytics service — preset/custom query construction, bucket parameter, abort
  signal forwarding, workspace-id encoding.
- Dashboard date model/formatting — UTC half-open conversion, 366-day limit,
  bucket coarsening, period/bucket labels, duration formatting.
- `useDashboardAnalytics` — three reads, no-workspace no-op, immediate tenant
  clear, stale-response rejection across workspace switches, custom windows,
  403 mapping, refresh.
- `DashboardPage` — KPI/status/trend rendering, loading, empty workspace,
  retryable error, 403, preset + custom range changes, invalid custom range,
  refresh, workspace switch without stale values.
- `TicketTrendChart` — series/total rendering, all-zero empty state, keyboard
  bucket inspection.
- Theme utilities — resolution and DOM application.

Not covered: pixel-level visual regressions, and automated end-to-end tests of
the logged-in flows (verified manually in the browser against the real API).
Dashboard component tests mock the analytics service; the browser run used the
actual Prompt 18 endpoints and real ticket records.

---

## 15. Extending the frontend (Prompts 22–25)

1. **Add the route** in `route-paths.ts`, the page in `features/<domain>/pages/`
   and a child route under `AppLayout` (`lazy()`), then enable the nav entry.
2. **Add the service** in `features/<domain>/<domain>.service.ts` with the
   exact backend path and the server’s response types; never build URLs in
   components.
3. **Reuse the design system** — Card/Table/Tabs/Field/Badge/EmptyState cover
   most list and form surfaces; add a variant before adding a component. The
   dashboard's KPI/status/chart pieces are analytics-specific, not generic
   dashboard primitives.
4. **Wire mutations** through `useToast()` for success, `ErrorState`/`Field`
   for failure, and `ConfirmDialog` for anything destructive.
5. **Keep the tenant honest:** read `workspaceId` from the active workspace or
   the route, and let the server authorize it; never send a client-decided
   role or user id.
6. **Test the contract:** render the component with Testing Library and assert
   the accessible behaviour (name, state, keyboard path), not class names.

---

## 16. Known limitations

- **Signup and email-verification screens are not implemented.** The backend
  supports `POST /auth/register` and `POST /auth/verify-email`; no UI was built
  because Prompt 20 scopes authentication UI to sign-in, session, sign-out and
  workspace access. The verification link points at `/verify-email`, which does
  not exist yet.
- **Workspace invitations/member management are backend-limited** — no invite
  endpoints exist, so no UI exists (see §9).
- **Password-reset completion was not verified end-to-end in a browser**
  because the development email provider keeps the one-time token in an
  in-process outbox with no HTTP access. The request endpoint, malformed-link
  state and real invalid/expired-token response were verified; a real inbox is
  needed to complete a reset.
- **Dashboard counts have mixed scopes by backend design.** `total`, `byStatus`,
  active backlog and customer totals cover all current workspace records;
  period counts and durations are window-scoped. The UI labels this, but an
  admin should not read the status mix as “status within the selected range”.
- **The dashboard consumes only overview/tickets/performance.** AI analytics
  (`/analytics/ai`) and the CSV ticket report exist but are outside Prompt 21's
  dashboard scope; no report-builder UI was added.
- **Analytics is not available to agents/viewers** (`analytics.view` is
  owner/admin). Those roles see the 403 surface on `/dashboard`; a role-specific
  landing surface is a later product decision.
- **Custom windows are capped at 366 days** and always computed in UTC; the
  workspace timezone string is not used for bucketing (server limitation).
- **Workspace settings/rename UI is not included** (the `PATCH /workspaces/:id`
  backend route exists; settings screens belong to a later prompt).
- **No route exists yet for tickets/conversations/customers/KB/settings or a
  separate analytics report page**; their nav entries are `aria-disabled` so
  nothing 404s. The analytics *dashboard* is `/dashboard`, not `/analytics`.
- **Notification bell is read-only** — it shows the caller’s real unread count
  but the inbox route ships later.
- **No React Query / server cache**; each surface fetches what it renders.
- **No Socket.IO client**; the real-time phase will add it behind a service.
- **No visual/browser regression tests**; verification is typecheck, lint,
  unit tests and a production build.
- `workspace.settings.timezone` is a free-form server string, so the UI shows
  it as-is instead of formatting dates per workspace timezone.
