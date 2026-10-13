# MVCC and consistent snapshots

PostgreSQL uses multi-version concurrency control (MVCC): an update creates a new row
version, while a query chooses the versions visible to its transaction snapshot. An
ordinary `SELECT` does not lock the rows it reads, so readers normally do not block
writers and writers normally do not block readers. This is why a read query can run
while an order status is being updated.

MVCC is about visibility, not conflict resolution. When code reads a row, makes a
decision, and then writes that row, it must still use an atomic conditional write, a
row lock, or a stronger isolation level. `TransitionOrderStatus` uses `FOR UPDATE`
for that reason; `GetOrder` does not need a write lock.

## Isolation levels used by the service

PostgreSQL's default, `READ COMMITTED`, gives each statement a fresh snapshot. It is
ideal for most single-statement reads and writes, but two `SELECT`s in one transaction
can see different committed states.

`GetOrder` needs two queries: one for `orders`, then one for `order_items`. It runs as
`READ ONLY REPEATABLE READ`, so both queries use the snapshot established by its first
query. It sees a self-consistent committed view even if another transaction updates an
order after the read starts. It does not see changes committed after that snapshot.

`REPEATABLE READ` can raise SQLSTATE `40001` when a transaction also writes and a
concurrent writer creates a serialization conflict. Keep this endpoint read-only; if a
future workflow needs a read-modify-write decision, use an explicit row lock or retry
the entire transaction after `40001`.

## Observe snapshot behavior

Create an order first, then replace the UUID below. Open two `psql` sessions.

Session A holds a repeatable-read snapshot:

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT id, status FROM orders
WHERE id = '00000000-0000-4000-8000-000000000001';
-- Leave this transaction open.
```

Session B commits a change without waiting for session A's plain `SELECT`:

```sql
BEGIN;
UPDATE orders
SET status = 'CONFIRMED'
WHERE id = '00000000-0000-4000-8000-000000000001'
  AND status = 'PENDING';
COMMIT;
```

Back in session A, the same query still returns the status visible when its snapshot
was taken:

```sql
SELECT id, status FROM orders
WHERE id = '00000000-0000-4000-8000-000000000001';
COMMIT;
```

Start a new transaction in session A to see session B's committed version. To compare,
repeat the experiment with `BEGIN` (the default `READ COMMITTED` level): the second
`SELECT` sees the newly committed value because it gets a new statement snapshot.

## Operational guidance

- Keep transactions short. A long-running snapshot can prevent vacuum from reclaiming
  obsolete row versions, causing table and index bloat.
- Use a statement timeout for reporting or export transactions. Do not hold snapshots
  open while waiting for a user or remote service.
- Check `pg_stat_activity` for old transactions when vacuum cannot advance. The
  `xact_start` timestamp is more useful than connection age.
- Use `SERIALIZABLE` only when the business invariant spans rows or predicates that
  locks and atomic statements cannot protect. It requires a complete-transaction retry
  strategy for SQLSTATE `40001`.
