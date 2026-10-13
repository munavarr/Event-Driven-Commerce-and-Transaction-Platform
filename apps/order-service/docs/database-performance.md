# PostgreSQL order-query performance

## Indexes in this service

All indexes below are PostgreSQL B-trees, the default and appropriate index type for equality predicates and ordered ranges.

| Read path | Supporting index | Why it fits |
| --- | --- | --- |
| One order by ID | `orders_pkey` | Primary-key lookup |
| Idempotent retry | unique index on `idempotency_key` | Exact lookup and uniqueness enforcement |
| A customer's complete history | `orders_customer_created_idx (customer_id, created_at DESC, id DESC) INCLUDE (status, total_amount_minor, currency)` | Filters by customer and returns a deterministic newest-first keyset page without sorting |
| A customer's orders in one status | `orders_customer_status_created_covering_idx (customer_id, status, created_at DESC, id DESC) INCLUDE (total_amount_minor, currency)` | Composite key follows equality predicates then the sort; included columns can make the history projection index-only |
| Line items for an order | unique index on `(order_id, product_id)` | Its leftmost `order_id` prefix makes the separate `order_id` index redundant |

Column order is intentional: a B-tree can efficiently use the leftmost columns. The status-aware index is not a replacement for `orders_customer_created_idx`, because omitting `status` would no longer preserve a global `created_at` ordering for that customer. Both use `id` as a tie-breaker, so pagination remains deterministic when timestamps match.

The covering index is narrowly targeted. `INCLUDE` columns are not part of sort or filter semantics, but allow this projection to avoid heap access when the visibility map says the matching pages are all-visible:

```sql
SELECT id, status, total_amount_minor, currency, created_at
FROM orders
WHERE customer_id = '00000000-0000-4000-8000-000000000001'
  AND status = 'CONFIRMED'
ORDER BY created_at DESC
LIMIT 50;
```

`GET /orders?customerId={uuid}&status=CONFIRMED&pageSize=50` uses this access
path. It returns a `nextCursor`; pass it as `cursor` for the next page. The
cursor is based on `(created_at, id)`, so later pages seek directly to the next
row rather than scanning an ever-growing `OFFSET`.

An `Index Only Scan` is an opportunity, not a guarantee. Freshly changed pages need heap visibility checks until vacuum marks them all-visible. Do not add duplicate indexes merely to force that plan.

## Reading the real plan

Run this against a production-like dataset. `EXPLAIN ANALYZE` executes the statement, so use it only with a safe read-only query (or a rollback transaction for writes).

```sql
EXPLAIN (ANALYZE, BUFFERS, SETTINGS, VERBOSE)
SELECT id, status, total_amount_minor, currency, created_at
FROM orders
WHERE customer_id = '00000000-0000-4000-8000-000000000001'
  AND status = 'CONFIRMED'
ORDER BY created_at DESC
LIMIT 50;
```

Compare `rows` with `actual rows` at every node. A large mismatch indicates stale or insufficient statistics; high `shared read` buffer counts point to physical I/O; `Heap Fetches: 0` on an `Index Only Scan` confirms no heap reads. `Planning Time` and `Execution Time` describe separate costs.

For a plan that is unexpectedly slow, collect the plan first, then inspect statistics:

```sql
ANALYZE orders;

SELECT attname, n_distinct, most_common_vals, most_common_freqs
FROM pg_stats
WHERE schemaname = 'public' AND tablename = 'orders'
  AND attname IN ('customer_id', 'status', 'created_at');

SELECT stxname, stxkeys, stxkind
FROM pg_statistic_ext
WHERE stxname = 'orders_customer_status_stats';
```

`ANALYZE` refreshes the planner's estimates. Autovacuum normally does this; after a bulk load, run `ANALYZE` explicitly. Vacuum also makes index-only scans more likely, but `VACUUM` must run outside a transaction block.

## Sequential scans are sometimes optimal

A sequential scan is expected when a query needs a large fraction of `orders`, when a predicate is not selective, or when the table is small/cached. It avoids random heap lookups and can be cheaper than an index plan. Treat it as a problem only when `EXPLAIN ANALYZE` shows it is slower than the workload permits.

Optimisation loop: capture the real query and parameters, use `EXPLAIN (ANALYZE, BUFFERS)`, fix statistics or query shape first, add the smallest workload-backed index only when it reduces measured cost, and then monitor write overhead and index usage through `pg_stat_user_indexes`.
