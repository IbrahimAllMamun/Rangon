# Backups

> A backup that has never been restored is not a backup. Rehearse quarterly and record the date below.

## What is backed up

| Data | Method | Frequency | Retention |
|---|---|---|---|
| PostgreSQL | `pg_dump -Fc` (custom format, compressed) | nightly 02:00 Asia/Dhaka | 7 daily, 4 weekly, 12 monthly |
| PostgreSQL WAL (if managed/PITR available) | continuous archiving | continuous | 7 days |
| Media / product images | object-storage versioning + cross-bucket sync | nightly | 30 days |
| Secrets | secret manager's own versioning | on change | 10 versions |
| Infrastructure config | this git repository | on commit | forever |

Backups are copied **off the application server** — a snapshot sitting on the same disk as the database
is not a backup.

## Scripts

```bash
./scripts/backup-db.sh [label]     # dump → gzip → upload → prune old copies
./scripts/restore-db.sh <file>     # restore into a target database (asks for confirmation)
```

`backup-db.sh` writes `rangon-<env>-<UTC timestamp>[-label].dump`, uploads it, verifies the object size,
and exits non-zero if anything fails — so a broken backup pages someone instead of failing silently.

## Scheduling

Production runs the dump from a cron/scheduled job on the database host or as a Kubernetes CronJob —
**not** inside the API container (which may be scaled to zero or rolled at any moment).

## Verification

1. Every backup: exit code checked, uploaded object size compared against the local file.
2. Weekly (automated): `pg_restore --list` on the newest dump proves it is readable.
3. Quarterly (manual): full restore into a scratch database, run migrations, run the smoke test, compare
   row counts for `orders_order`, `inventory_inventorytransaction`, `catalog_productvariant`.

| Rehearsal date | Backup restored | Result | By |
|---|---|---|---|
| _(not yet performed)_ | | | |

**This table is empty. Until it has a row, treat the backup strategy as untested** — this is gap #4 in
`docs/roadmap.md`.

## Targets

- **RPO** (data we can afford to lose): 24 h with nightly dumps; ≤ 5 min if PITR is enabled.
- **RTO** (time to be back up): ≤ 60 min for a database restore, ≤ 10 min for an application rollback.

Restore instructions: [disaster-recovery.md](disaster-recovery.md).
