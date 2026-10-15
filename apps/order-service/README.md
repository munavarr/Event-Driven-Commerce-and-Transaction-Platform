<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ pnpm install
```

## Local PostgreSQL

From `commerce-platform`, start the database and wait for its health check:

```bash
docker compose -f infra/docker-compose.yml up -d
cp apps/order-service/.env.example apps/order-service/.env
pnpm --filter order-service db:migrate
```

The Order service uses PostgreSQL through a bounded Knex connection pool. Configure
`DATABASE_URL`, `DB_POOL_MIN`, and `DB_POOL_MAX` in its local `.env` file; keep that
file out of source control. The initial migration creates `orders` and `order_items`,
with database-level checks, an idempotency-key uniqueness constraint, and the
`order_items.order_id → orders.id` foreign key.

## Order correctness guarantees

`CreateOrder` validates the request, calculates totals from item prices, and inserts
the order and every item in one managed Knex transaction. An exception from either
insert rolls back the whole operation. The service stores a SHA-256 fingerprint of a
canonical request payload alongside the unique idempotency key: retrying the same
request returns the original order, while reusing the key for a different payload is
rejected. `TransitionOrderStatus` locks the order row before validating and updating
its state, so competing requests cannot silently overwrite an order state.

The transaction deliberately contains only PostgreSQL writes. It also writes an
`outbox_events` row in the same transaction. A background publisher delivers that
durable record to Kafka after the transaction commits, so an order is never committed
without a corresponding `OrderCreated` event. No Kafka, payment, or other network
call is made while the order transaction is open.

## Kafka event flow

Start Kafka with the local stack, then migrate and run the service:

```bash
docker compose -f infra/docker-compose.yml up -d
pnpm --filter order-service db:migrate
pnpm --filter order-service start:dev
```

`CreateOrder` produces a versioned JSON event on `commerce.order.created.v1` through
the transactional outbox. The Kafka key is `order.id`: records for one order remain
ordered while Kafka can distribute different orders across the topic's three
partitions. The local single broker uses replication factor one; production must use
at least three brokers and a replication factor of three.

The event envelope has `eventId`, `eventType` (`commerce.order.created`),
`schemaVersion` (`1`), `occurredAt`, and the order snapshot. Monetary minor units are
strings so JavaScript number precision cannot corrupt large amounts. Consumers reject
unknown schemas rather than guessing how to deserialize them.

Two independent consumer groups subscribe to the same topic:

- `notifications-v1` queues the order-created notification.
- `analytics-v1` records the order-created analytical fact.

Each group receives every event independently; adding consumers within a group shares
partitions and triggers Kafka's normal rebalance. Kafka commits a group's offset only
after its handler succeeds, or after a dead-letter publish succeeds. The consumer
retries a failed message three times with backoff before publishing it, with the
original key, payload, consumer group, and failure reason, to
`commerce.order.created.v1.dlt`. The outbox
publisher and consumers are intentionally at-least-once: a process failure after
Kafka accepts a message but before the database acknowledgement can produce a
duplicate. Downstream handlers must persist `eventId` as their idempotency key.

Set `KAFKA_ENABLED=false` to run database-only tests or local development without a
broker. `KAFKA_BROKERS` accepts a comma-separated broker list.

Inventory is not owned by Order Service. `CreateOrder` commits a `PENDING` order and
emits `commerce.order.created.v1`; Inventory Service reserves stock in its own local
transaction and returns a reservation result. The checkout saga is documented in
[`../../ARCHITECTURE.md`](../../ARCHITECTURE.md). This deliberate asynchronous boundary
means callers must poll the order (or subscribe to an order-status notification) rather
than treating a successful create response as a completed checkout.

PostgreSQL is also the final integrity boundary. Its constraints reject negative stock,
invalid currencies and quantities, duplicate products in an order, and invalid order
statuses. Deferred constraint triggers require every committed order to have line
items whose totals equal the order total, while a status-transition trigger rejects
state changes that bypass the workflow.

## Database query performance

The schema uses B-tree indexes for primary keys, idempotency, customer history, and
line-item lookups. Customer/status history uses a composite covering index to enable
an index-only scan when PostgreSQL's visibility map permits it. The performance guide
explains the index choices, when a sequential scan is correct, and how to inspect
actual query plans and statistics with `EXPLAIN ANALYZE`:

```bash
less docs/database-performance.md
```

## Redis read cache

`GetOrder` is cache-aside with a 60-second TTL; paginated customer-history reads
have a 20-second TTL. Set `REDIS_URL` to enable it (the service continues directly
to PostgreSQL when it is unset or Redis is unavailable). A cache miss uses a short
Redis lease so a normal burst loads one value rather than stampeding PostgreSQL.

Order creation and status transitions invalidate the order key only after their
database transaction commits. They also increment a per-customer history version,
which invalidates all history pages without an expensive Redis `SCAN`. Old versioned
keys expire naturally. Redis is configured with `noeviction`: once its bounded memory
is full, writes fail safely and reads fall back to PostgreSQL rather than evicting an
invalidation version. It is strictly an optimization, never the source of truth.

## Concurrency and lock recovery

Order-status transitions use a short `SELECT ... FOR UPDATE` transaction so a stale
concurrent request cannot overwrite a newly committed state. The locking guide includes
two-session lock-contention and deadlock experiments, diagnostic queries, and safe
recovery rules for SQLSTATE `40P01`, `40001`, and `55P03`:

```bash
less docs/locking-and-deadlocks.md
```

## MVCC and consistent reads

`GetOrder` reads the order and its line items in a read-only `REPEATABLE READ`
transaction. PostgreSQL MVCC gives both queries one committed snapshot without making
ordinary readers block writers. See the snapshot guide for isolation-level behavior,
safe experiments, and operational considerations:

```bash
less docs/mvcc-and-snapshots.md
```

## PostgreSQL concurrency tests

The unit suite uses an in-memory database double; the opt-in concurrency suite uses
two independent PostgreSQL connection pools against the separate `postgres-test`
container. It proves that only one simultaneous checkout can reserve the final unit
and that two atomic decrements on one inventory row preserve both changes.

```bash
# Starts postgres-test, waits for its health check, migrates only that database,
# then runs the oversell, lost-update, and state-transition experiments.
pnpm --filter order-service test:concurrency:docker
```

## Advanced PostgreSQL query patterns

The query-patterns guide provides production-oriented CTE, recursive CTE, window
function, offset, and keyset-pagination examples for the order schema. It also sets
out when partitioning is worthwhile and the primary-key/foreign-key redesign needed
before safely partitioning `orders` by time:

```bash
less docs/advanced-query-patterns.md
```

## Compile and run the project

```bash
# development
$ pnpm run start

# watch mode
$ pnpm run start:dev

# production mode
$ pnpm run start:prod
```

## Run tests

```bash
# unit tests
$ pnpm run test

# e2e tests
$ pnpm run test:e2e

# test coverage
$ pnpm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ pnpm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Observability

In production applications, observability is essential for understanding how your system behaves, detecting issues early, and maintaining reliable performance.

[NestJS Observe](https://observe.nestjs.com) automatically instruments your NestJS application, giving you deep visibility into your system with minimal setup:

- **Distributed tracing:** Follow requests across services and understand how they flow through your system.
- **Waterfall analysis:** Visualize request execution and identify slow operations, bottlenecks, and unexpected delays.
- **Performance analysis:** Analyze application performance in real time and quickly pinpoint areas that need optimization.
- **Metrics:** Track key application and infrastructure metrics to understand system health and performance trends.
- **Logging:** Centralize and correlate logs with traces and other telemetry to make debugging easier.
- **Error tracking:** Detect errors quickly and investigate their root causes with the surrounding context.
- **SLA monitoring:** Track service-level objectives and identify when your application is approaching or exceeding defined thresholds.
- **Alarms and alerts:** Set up alerts for critical errors, performance degradation, SLA violations, and other anomalies so your team can react quickly.

This project is already instrumented. Create a free account at [observe.nestjs.com](https://observe.nestjs.com), add an application, and paste the generated app key and secret into the `ObserveModule.forRoot()` call in `src/app.module.ts`.

The free plan needs no payment details and covers 300,000 events a month. You can also browse the [live demo](https://www.observe-demo.nestjs.com/dashboard) first - the whole dashboard over a busy service's data, with nothing to install.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Auto-instrument your application with [NestJS Observe](https://observe.nestjs.com). Distributed tracing, metrics, and logging made easy. Error tracking and performance monitoring for your NestJS applications.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
