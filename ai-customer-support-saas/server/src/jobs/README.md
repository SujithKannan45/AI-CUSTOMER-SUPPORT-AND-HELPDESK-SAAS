# Background jobs (prepared, not yet implemented)

Work that must not block an HTTP request lands here: document ingestion and
chunking/embedding after uploads, digest notifications, analytics rollups,
stale-ticket sweeps.

## Planned structure

```
jobs/
├── queues.ts        # BullMQ queue definitions (Redis-backed)
├── workers/         # One worker file per queue
└── schedulers/      # Repeatable jobs (cron-style)
```

## Why a queue instead of `setTimeout`

- Retries with backoff for flaky external calls (AI providers, S3).
- Survives process restarts and deploys.
- Rate-limits AI provider calls centrally.

Redis becomes a required dependency only when the jobs phase lands; the
`docker-compose.yml` file ships commented-out so enabling it is a one-line
change.
