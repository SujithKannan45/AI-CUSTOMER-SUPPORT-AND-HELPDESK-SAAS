# Backend modules

Each bounded feature lives in its own self-contained module. Modules never
reach into each other's internals — they communicate through exported service
functions or interfaces in `interfaces/`.

## Canonical layout for a feature module

```
modules/<feature>/
├── <feature>.model.ts        # Mongoose schema + typed model (tenant-scoped)
├── <feature>.repository.ts   # All DB queries; no business logic
├── <feature>.service.ts      # Business rules; throws AppError subclasses
├── <feature>.controller.ts   # HTTP shape only: parse req → call service → res
├── <feature>.routes.ts       # Declarative wiring: router + validate() schemas
├── <feature>.validation.ts   # Zod schemas for request bodies/queries
├── <feature>.types.ts        # Shared TS types & constants
└── interfaces/               # Ports for external providers (AI, storage…)
```

## Planned modules

`auth`, `users`, `workspaces`, `customers`, `tickets`, `conversations`,
`knowledge-base`, `documents`, `ai`, `notifications`, `analytics`, `audit-logs`.

Only `health` is implemented in the foundation phase. `ai` and `documents`
contain **interface seams only** (no provider SDKs wired yet).

## Conventions

- Controllers never contain business logic; services never import Express.
- Every public route is validated with a Zod schema via `validate()`.
- All queries are tenant-scoped: every tenant-owned schema carries a
  `workspaceId` field and an index on it (see `docs/architecture.md`).
- Repositories may not leak Mongoose documents past the service layer.
