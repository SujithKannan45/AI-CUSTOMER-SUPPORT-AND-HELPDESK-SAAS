# Frontend architecture & design system (Prompt 19)

This document describes the React application as it exists today. It is a
maintainer's guide, not a roadmap: every path, token and behaviour named here is
implemented in `client/`.

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
    │   ├── guards/             # require-auth (session bootstrap + redirect)
    │   └── routes/             # route-paths (single source for path strings)
    ├── components/
    │   ├── ui/                 # design system (see §4)
    │   ├── common/             # page-header, page-transition
    │   ├── navigation/         # breadcrumbs
    │   └── feedback/           # states, spinner, error-boundary
    ├── config/env.config.ts    # the only reader of import.meta.env
    ├── features/
    │   ├── auth/               # types, service, session store
    │   ├── workspace/          # types, service, store, hooks
    │   ├── dashboard/          # dashboard-only components
    │   └── notifications/      # unread-count service
    ├── hooks/                  # use-debounce, use-media-query, use-theme, use-toast
    ├── layouts/                # app-layout + sidebar/header/workspace-switcher/…
    ├── pages/                  # dashboard, login placeholder, not found
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
  `HttpApiError.isValidationError` and `error.details` carry them; Prompt 20+
  maps `details` onto `Field` errors rather than duplicating rules.
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
| `/login` | public | placeholder page; Prompt 20 owns the real screens |
| `/`, `/dashboard` | protected | `RequireAuth` → `AppLayout` → lazy `DashboardPage` |
| `*` | protected | not-found page inside the shell |

`RequireAuth` (`app/guards/require-auth.tsx`):

1. Runs `session.bootstrap()` once per app load: silent refresh-cookie exchange
   plus `GET /api/v1/auth/me`.
2. Renders `LoadingState` while resolving — never a flash of protected content.
3. Redirects to `/login` (carrying `state.from`) when the session is rejected.
4. Renders a **retryable error** when the API is unreachable — a network
   failure is not treated as “logged out”.
5. Drops the session and redirects when a later request reports the session is
   gone (`subscribeToAuthFailure`).

To add a route in a later prompt: add the path to `route-paths.ts`, add the
page under `pages/` (or a feature’s pages), insert a child route inside the
`AppLayout` subtree with `lazy()`, then flip the matching `nav-items.ts`
entry to `enabled: true`.

---

## 8. API client

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

## 9. State management

| State | Where | Why |
| --- | --- | --- |
| Sidebar open, theme preference | `store/ui.store.ts` (Zustand, theme persisted) | global UI, tiny, changes rarely |
| Session: status, user, bootstrap/signOut | `features/auth/auth.store.ts` (Zustand) | needed by the guard, header and every page |
| Workspace list + active workspace | `features/workspace/workspace.store.ts` (Zustand) | one fetch per session, read by the shell |
| Toasts | React state in `ToastProvider` | transient, owned by one subtree |
| Form input, open/closed UI, fetched page data | local component state | the default; do not globalise it |

Server data is fetched by the surface that needs it through a typed service.
There is **no** React Query today: the pages that would justify a cache
(tickets, inbox, analytics) are Prompt 21+. When one lands, add TanStack Query
in `AppProviders` and keep the existing services as the fetch layer — the
component API does not change.

---

## 10. Responsive & accessibility conventions

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

## 11. Tests

```bash
npm run test --workspace client      # vitest run
npm run test:watch --workspace client
```

Configuration: `client/vitest.config.ts` (jsdom, React plugin, `@` alias,
`src/test/setup.ts`). Tests live next to the code as `*.test.ts(x)`.

Covered today (42 tests, 10 files):

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
- Theme utilities — resolution and DOM application.

Not covered: layout rendering, browser-level visual behaviour, and the
dashboard’s live API status card (needs a running server).

---

## 12. Extending the frontend (Prompts 20–25)

1. **Add the route** in `route-paths.ts`, the page in `features/<domain>/pages/`
   and a child route under `AppLayout` (`lazy()`), then enable the nav entry.
2. **Add the service** in `features/<domain>/<domain>.service.ts` with the
   exact backend path and the server’s response types; never build URLs in
   components.
3. **Reuse the design system** — Card/Table/Tabs/Field/Badge/EmptyState cover
   most list and form surfaces; add a variant before adding a component.
4. **Wire mutations** through `useToast()` for success, `ErrorState`/`Field`
   for failure, and `ConfirmDialog` for anything destructive.
5. **Keep the tenant honest:** read `workspaceId` from the active workspace or
   the route, and let the server authorize it; never send a client-decided
   role or user id.
6. **Test the contract:** render the component with Testing Library and assert
   the accessible behaviour (name, state, keyboard path), not class names.

---

## 13. Known limitations

- **Sign-in UI is not implemented** (Prompt 20). `/login` is an honest
  placeholder; the guard, services and token lifecycle around it are real.
- **No route exists yet for tickets/conversations/customers/KB/analytics/
  settings**; their nav entries are `aria-disabled` so nothing 404s.
- **Notification bell is read-only** — it shows the caller’s real unread count
  but the inbox route ships later.
- **No React Query / server cache**; each surface fetches what it renders.
- **No Socket.IO client**; the real-time phase will add it behind a service.
- **No visual/browser regression tests**; verification is typecheck, lint,
  unit tests and a production build.
- `workspace.settings.timezone` is a free-form server string, so the UI shows
  it as-is instead of formatting dates per workspace timezone.
