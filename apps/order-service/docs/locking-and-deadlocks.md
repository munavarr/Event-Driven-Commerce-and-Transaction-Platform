# Row locking, contention, and deadlocks

`TransitionOrderStatus` locks the selected `orders` row with `SELECT ... FOR UPDATE` inside one short transaction. The lock prevents another transaction from changing or locking that row until the first transaction commits or rolls back. After waiting, the second transition reads the current status and fails its expected-state check rather than overwriting it.

Keep the transaction small: validate before acquiring the lock, make only database calls while it is held, and commit immediately after the update. Do not call payment, Kafka, or any remote service in the locked transaction.

`FOR UPDATE` is appropriate when code must read a row, make a decision, and later write it. A single conditional `UPDATE ... WHERE id = ? AND status = ?` is often a lower-contention alternative when no intermediate read is needed. Plain `SELECT` does not lock the row. `FOR SHARE`/`FOR KEY SHARE` have weaker semantics and are not a substitute for a state-transition write lock.

## Reproduce row-lock contention

Create an order and substitute its UUID below. Open two `psql` sessions connected to the same database.

Session A:

```sql
BEGIN;
SELECT id, status FROM orders
WHERE id = '00000000-0000-4000-8000-000000000001'
FOR UPDATE;
-- Leave this transaction open.
```

Session B (this waits until A commits or rolls back):

```sql
BEGIN;
SELECT id, status FROM orders
WHERE id = '00000000-0000-4000-8000-000000000001'
FOR UPDATE;
COMMIT;
```

While B waits, inspect both the blocked and blocking sessions from a third session:

```sql
SELECT blocked.pid AS blocked_pid,
       blocking.pid AS blocking_pid,
       blocked.query AS blocked_query,
       blocking.query AS blocking_query
FROM pg_stat_activity AS blocked
JOIN pg_locks AS blocked_lock ON blocked_lock.pid = blocked.pid
JOIN pg_locks AS blocking_lock
  ON blocking_lock.locktype = blocked_lock.locktype
 AND blocking_lock.database IS NOT DISTINCT FROM blocked_lock.database
 AND blocking_lock.relation IS NOT DISTINCT FROM blocked_lock.relation
 AND blocking_lock.page IS NOT DISTINCT FROM blocked_lock.page
 AND blocking_lock.tuple IS NOT DISTINCT FROM blocked_lock.tuple
 AND blocking_lock.transactionid IS NOT DISTINCT FROM blocked_lock.transactionid
 AND blocking_lock.classid IS NOT DISTINCT FROM blocked_lock.classid
 AND blocking_lock.objid IS NOT DISTINCT FROM blocked_lock.objid
 AND blocking_lock.objsubid IS NOT DISTINCT FROM blocked_lock.objsubid
 AND blocking_lock.pid <> blocked_lock.pid
JOIN pg_stat_activity AS blocking ON blocking.pid = blocking_lock.pid
WHERE NOT blocked_lock.granted AND blocking_lock.granted;
```

End session A with `COMMIT` to let B proceed, or `ROLLBACK` to discard A's work. For bounded API latency, set a per-transaction `lock_timeout`, for example `SET LOCAL lock_timeout = '2s';`; PostgreSQL returns SQLSTATE `55P03` if it cannot acquire the lock in time.

## Reproduce a deadlock

Use two different order UUIDs. The experiment deliberately takes locks in opposite order and must never be copied into application code.

Session A:

```sql
BEGIN;
SELECT id FROM orders WHERE id = '00000000-0000-4000-8000-000000000001' FOR UPDATE;
-- Wait until session B has locked its row.
SELECT id FROM orders WHERE id = '00000000-0000-4000-8000-000000000002' FOR UPDATE;
COMMIT;
```

Session B:

```sql
BEGIN;
SELECT id FROM orders WHERE id = '00000000-0000-4000-8000-000000000002' FOR UPDATE;
-- Wait until session A has locked its row.
SELECT id FROM orders WHERE id = '00000000-0000-4000-8000-000000000001' FOR UPDATE;
COMMIT;
```

PostgreSQL detects the cycle after `deadlock_timeout`, aborts one transaction with SQLSTATE `40P01`, and allows the other to continue. The aborted transaction is unusable: issue `ROLLBACK` before reusing its connection.

## Prevention and recovery

- Lock multiple rows in one global order (for example, ascending `orders.id`) everywhere in the service.
- Make transactions short and avoid user interaction, network calls, and expensive computation while locks are held.
- Handle `40P01` (deadlock) and `40001` (serialization failure) by rolling back and retrying the complete transaction with capped exponential backoff plus jitter. Retrying only the failed statement is incorrect because the transaction is aborted.
- Treat `55P03` (lock-not-available/timeout) as a bounded-latency failure; retry only when the operation is idempotent and its caller can tolerate waiting.
- Preserve idempotency keys for externally initiated writes. A retry after an unknown network outcome must not create a second order.
- Do not terminate database backends as a normal recovery tactic. Diagnose long transactions through `pg_stat_activity`, correct the lock order, then use an operational escalation process if a session is truly stuck.
