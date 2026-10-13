# CTEs, windows, pagination, and partitioning

This guide uses the existing `orders` and `order_items` tables. Run examples against representative data and inspect them with `EXPLAIN (ANALYZE, BUFFERS)` before putting them on a hot path.

## CTEs

Use a CTE to name a logical stage, not automatically to make a query faster. Modern PostgreSQL can inline a single-use, side-effect-free CTE; `MATERIALIZED` deliberately creates an optimization fence, and `NOT MATERIALIZED` asks PostgreSQL to inline when possible.

This report first finds a customer's confirmed orders in a time range, then aggregates their line items. It keeps the fact-table filtering in one readable location.

```sql
WITH confirmed_orders AS NOT MATERIALIZED (
  SELECT id, total_amount_minor
  FROM orders
  WHERE customer_id = '00000000-0000-4000-8000-000000000001'
    AND status = 'CONFIRMED'
    AND created_at >= now() - interval '30 days'
)
SELECT item.product_id,
       sum(item.quantity) AS units_sold,
       sum(item.line_total_minor) AS revenue_minor,
       count(*) AS order_lines
FROM confirmed_orders AS o
JOIN order_items AS item ON item.order_id = o.id
GROUP BY item.product_id
ORDER BY revenue_minor DESC, item.product_id;
```

Use `MATERIALIZED` only when the same expensive CTE result is referenced repeatedly or when you intentionally need its single evaluation. Avoid data-modifying CTEs in normal request paths: they execute under one snapshot and can make write ordering less obvious.

## Recursive CTEs

The current schema intentionally has no self-referential hierarchy. Do not manufacture one merely to use recursion. The following query is a useful workflow check: it recursively walks the status-transition graph that the service permits and records paths from `PENDING`.

```sql
WITH RECURSIVE transitions(from_status, to_status) AS (
  VALUES
    ('PENDING'::text, 'CONFIRMED'::text),
    ('PENDING', 'CANCELLED'),
    ('PENDING', 'PAYMENT_FAILED'),
    ('PAYMENT_FAILED', 'CANCELLED')
), workflow(status, path) AS (
  VALUES ('PENDING'::text, ARRAY['PENDING']::text[])
  UNION ALL
  SELECT t.to_status, w.path || t.to_status
  FROM workflow AS w
  JOIN transitions AS t ON t.from_status = w.status
  WHERE NOT t.to_status = ANY (w.path)
)
SELECT status, path
FROM workflow
ORDER BY cardinality(path), path;
```

For a real hierarchy (for example, product categories), store a parent key, index it, include a cycle guard like the array above, and set a deliberate depth limit. Recursive CTEs can consume substantial memory and work if fan-out is unbounded.

## Window functions

Windows retain detail rows while calculating a value across their partition. This query ranks a customer's newest orders and shows a running total without collapsing results as `GROUP BY` would.

```sql
SELECT id,
       status,
       created_at,
       total_amount_minor,
       row_number() OVER (
         PARTITION BY customer_id
         ORDER BY created_at DESC, id DESC
       ) AS newest_rank,
       sum(total_amount_minor) OVER (
         PARTITION BY customer_id
         ORDER BY created_at, id
         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
       ) AS running_spend_minor
FROM orders
WHERE customer_id = '00000000-0000-4000-8000-000000000001'
ORDER BY created_at DESC, id DESC;
```

Filter the base rows before the window when that matches the report. To filter a window result such as `newest_rank <= 10`, put the window query in a subquery or CTE and filter the outer query; PostgreSQL evaluates `WHERE` before window functions.

## Pagination

Use a deterministic order. `created_at` alone is not stable because multiple orders can share a timestamp; `id` is the tie-breaker. The customer/status index has the matching `(customer_id, status, created_at DESC, id DESC)` key order.

Offset pagination is simple and appropriate for shallow administrative pages:

```sql
SELECT id, status, total_amount_minor, currency, created_at
FROM orders
WHERE customer_id = '00000000-0000-4000-8000-000000000001'
  AND status = 'CONFIRMED'
ORDER BY created_at DESC, id DESC
LIMIT 50 OFFSET 0;
```

Its cost grows with the offset and concurrent inserts can shift later pages. For an API feed, use keyset (seek) pagination. Return the last row's `created_at` and `id` as an opaque cursor; bind them as parameters on the next request:

```sql
SELECT id, status, total_amount_minor, currency, created_at
FROM orders
WHERE customer_id = $1
  AND status = $2
  AND (created_at, id) < ($3::timestamptz, $4::uuid)
ORDER BY created_at DESC, id DESC
LIMIT $5;
```

The first page omits the cursor predicate. The implemented `GET /orders` endpoint
uses this strategy: supply `customerId`, optional `status`, and optional
`pageSize`; then pass its opaque `nextCursor` back as `cursor`. Keyset pagination
gives stable forward progress and does not scan all preceding pages; it does not
promise a fixed snapshot across independently committed requests. Use a
transaction with the appropriate isolation level or a stored snapshot boundary
only when the product truly requires that guarantee.

## Table partitioning and pruning

Do not partition `orders` today just because it is time-based. Partitioning helps when the table is large enough that maintenance, retention, or queries can eliminate whole time ranges. It does not make an unselective query fast, and too many small partitions add planning overhead.

The present table cannot be converted in place without a deliberate key redesign: PostgreSQL requires a unique or primary key on a partitioned table to include all partition-key columns. A monthly `created_at` partition therefore cannot retain `PRIMARY KEY (id)` as-is, while `order_items.order_id` currently references that key. Plan this as a compatibility migration, not a routine index change.

A safe future migration has these stages:

1. Measure table size, retention needs, and representative time-bounded plans. Confirm that range predicates dominate.
2. Design a new partition-compatible identity/FK model, then backfill and validate it in a shadow table.
3. Create monthly range partitions ahead of time; route writes during a controlled cutover.
4. Verify pruning with a literal or parameterized range predicate, then detach/drop only expired partitions according to retention policy.

For example, a partitioned table is prunable only when the query constrains the partition key:

```sql
SELECT count(*)
FROM orders_partitioned
WHERE created_at >= timestamptz '2026-10-01 00:00:00+00'
  AND created_at <  timestamptz '2026-11-01 00:00:00+00';
```

Use `EXPLAIN (ANALYZE, VERBOSE)` to confirm that irrelevant partitions are absent from the plan. Avoid wrapping `created_at` in expressions such as `date(created_at)`, which can prevent pruning; express the condition as a half-open timestamp range instead.
