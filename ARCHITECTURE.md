# Checkout workflow

The platform uses asynchronous orchestration; each service owns its data and
communicates state changes through versioned Kafka events.  The Order API never
calls a downstream service while its database transaction is open.

```text
API Gateway -> Order Service -> commerce.order.created.v1
                                |
                                v
                         Inventory Service
                  reserved |           | rejected
                           v           v
                      Payment Service  Order Service -> CANCELLED
                  authorized |       | failed
                             v       v
                   Fulfillment Service Order Service -> PAYMENT_FAILED
                    created |      | failed
                            v      v
                Order Service -> CONFIRMED / CANCELLED
                             |
                             v
                    Notification Service
```

## Service ownership

| Service | Database it owns | Commands/events |
| --- | --- | --- |
| Order | orders, order items, outbox, processed events | creates orders; consumes saga results |
| Inventory | stock and reservations | consumes `order.created`; emits reservation result |
| Payment | payment attempts | consumes `inventory.reserved`; emits payment result |
| Fulfillment | shipments | consumes `payment.authorized`; emits fulfillment result |
| Notification | delivery log | consumes final order events; deduplicates by event id |

Every consumer must insert its `eventId` into an inbox table in the same local
transaction as its business write. Every producer must put its outgoing event in
its local outbox in that transaction. A publisher may deliver an event more than
once; consumers are therefore idempotent. No service reads or updates another
service's tables.

## Order states

`PENDING -> INVENTORY_RESERVED -> PAYMENT_AUTHORIZED -> CONFIRMED`

The failure branches are `PENDING -> CANCELLED` (inventory unavailable),
`INVENTORY_RESERVED -> PAYMENT_FAILED`, and `PAYMENT_AUTHORIZED -> CANCELLED`
(fulfillment failure).  Only the Order Service's Kafka consumer can apply these
transitions; they are intentionally not available through the public gateway.

## Local run

Copy each service's `.env.example` to `.env`, start PostgreSQL/Kafka from
`infra/docker-compose.yml`, then start each worker with `pnpm --filter <service>
start`. The worker creates only its own inbox, outbox, and domain tables. The payment
and fulfillment services use local adapters controlled by environment variables; swap
those adapters for a provider client before processing real money or shipments.
