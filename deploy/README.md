# Deploy & Operations

Operational runbook for the Lightsail deployment (`/opt/mandamail`, Docker Compose).

## Deploy

```bash
deploy/deploy.sh
```

Pulls `main`, rebuilds the app image while the old container keeps serving, then
recreates only the `app` container (Postgres/Redis stay up).

## Continuous Integration

`.github/workflows/ci.yml` runs on every push/PR to `main`:

- `npm ci` — reproducible install from the lockfile
- `npm test` — full Vitest suite (single pass)
- `npm audit --omit=dev --audit-level=high` — fails on high/critical CVEs in
  production dependencies

Keep `main` green before deploying.

## Database backups

### What gets backed up (and what does NOT)

The dump contains all app data, including IMAP passwords **in encrypted form**
(AES-256-GCM). The `ENCRYPTION_KEY` that decrypts them lives only in `.env` and
is deliberately **not** included in the backup. A leaked dump alone cannot
decrypt the passwords.

> Keep `ENCRYPTION_KEY` backed up **separately** (password manager / secrets
> vault), never in the same place as these dumps. Losing the key makes every
> stored IMAP password unrecoverable; leaking it next to a dump defeats the
> encryption.

### Run a backup

```bash
deploy/backup-db.sh
```

Writes a gzipped `pg_dump` to `/opt/mandamail-backups/emailbitrix-<timestamp>.sql.gz`,
verifies it is non-trivially sized, and prunes dumps older than 14 days
(override with `RETENTION_DAYS`).

### Schedule it (cron)

Daily at 03:00, logging to a file:

```bash
crontab -e
```

```cron
0 3 * * * /opt/mandamail/deploy/backup-db.sh >> /var/log/mandamail-backup.log 2>&1
# Weekly restore test (Sundays 04:00) — proves the backups are usable
0 4 * * 0 /opt/mandamail/deploy/test-restore.sh >> /var/log/mandamail-restore-test.log 2>&1
```

Make the scripts executable once:

```bash
chmod +x deploy/backup-db.sh deploy/test-restore.sh
```

### Verify a backup is usable (restore test)

```bash
deploy/test-restore.sh
```

Restores the latest dump into a **throwaway, isolated** Postgres container
(never production), checks the core tables exist and carry data, then removes
the container. Exit 0 means the backup is good; non-zero means investigate.

## Restore into production

Only when recovering from data loss. This overwrites the live database.

```bash
cd /opt/mandamail

# Pick the dump to restore
LATEST=$(ls -1t /opt/mandamail-backups/emailbitrix-*.sql.gz | head -n1)
echo "Restoring: $LATEST"

# Stop the app so nothing writes mid-restore (Postgres stays up)
docker compose stop app

# Load POSTGRES_USER/DB from .env, then restore
set -a; . ./.env; set +a
gunzip -c "$LATEST" | docker compose exec -T postgres \
  psql -U "${POSTGRES_USER:-emailbitrix}" -d "${POSTGRES_DB:-emailbitrix}"

# Bring the app back
docker compose up -d app
```

The dump uses `--clean --if-exists`, so it drops and recreates objects safely
onto the existing database. After restoring, confirm the app starts and the
per-account health endpoint (`GET /tenants/:id/imap-accounts/health`) reports
healthy workers.

## Environment variables

See `.env.example` for the full list. Reliability/observability additions:

| Variable | Purpose | Default |
| --- | --- | --- |
| `SILENT_ACCOUNT_MINUTES` | Minutes without an IMAP poll before an account is flagged silent and alerted | 15 |
| `HEARTBEAT_URL` | External monitor pinged on a cadence (dead-man's-switch for total outages) | disabled |
| `HEARTBEAT_INTERVAL_SEC` | Heartbeat ping interval | 60 |
| `DB_STATEMENT_TIMEOUT_MS` | Aborts runaway queries server-side so they can't exhaust the pool (migrations lift this per-transaction) | 30000 |
