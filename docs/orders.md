# Parent orders and supermarket sub-orders

## MongoDB requirement

Order creation, cancellation, fulfilment updates, and reservation expiry use MongoDB transactions. The deployment must be a replica set or sharded cluster; a standalone MongoDB server is not supported. The API does not fall back to non-transactional order writes. The current local deployment topology could not be determined from tracked files because the connection URI is in the ignored backend `.env`.

## Create an order

`POST /api/orders` requires a Clerk customer session and an `Idempotency-Key` header (8 to 128 safe characters).

```json
{
  "items": [
    { "storeId": "alpha-market", "productId": "rice-50kg", "quantity": 1 },
    { "storeId": "beta-market", "productId": "groundnut-oil", "quantity": 2 }
  ],
  "delivery": {
    "fullName": "Ada Customer",
    "address": "12 Market Road, Lagos",
    "phone": "+2348012345678"
  }
}
```

Only product/store IDs and integer quantities are accepted; prices, totals, store names, fees, and eligibility are looked up and calculated on the server. The route accepts the same public store slugs and product keys used by the catalog API, as well as Mongo IDs. It requires active, approved stores, available products, and current stock. A supermarket must independently meet the configured merchandise minimum. An ineligible or stale cart is rejected with `409`; validation errors use the API's `{ "error": { "code", "message" } }` shape and may include item-level `issues` or a fresh quote.

The successful response contains a `pending_payment` parent order and one `pending_payment` child per store. Product IDs, names, prices, quantities, store names, delivery details, and fee allocations are stored as order snapshots. Stock is reserved with conditional atomic decrements inside the same transaction as parent and child creation. A repeated key and identical normalized request returns the existing order with `reused: true`; the same key with different items or delivery details returns `409 IDEMPOTENCY_KEY_REUSED`.

Configured delivery and service fees are flat per order at present, and are allocated evenly across the child orders. Any remainder kobo is assigned deterministically by store slug. Fee defaults are zero; set `CHECKOUT_DELIVERY_FEE_KOBO` and `CHECKOUT_SERVICE_FEE_KOBO` before using customer-facing estimates.

## Read and cancel customer orders

- `GET /api/orders?page=1&limit=20` returns the signed-in customer's paginated history.
- `GET /api/orders/:orderId` returns an order only to its owning customer. `:orderId` accepts the public order number.
- `POST /api/orders/:orderId/cancel` cancels an unpaid `pending_payment` order and restores its reserved stock transactionally. Paid orders cannot be cancelled through this endpoint; refunds are not implemented.

## Supermarket fulfilment

- `GET /api/stores/:storeId/orders?page=1&limit=20&status=pending_payment` is limited to the owning supermarket; admins may view any store.
- `GET /api/stores/:storeId/orders/:orderId` and `PATCH /api/stores/:storeId/orders/:orderId/fulfillment` use the same store ownership scope.
- The fulfillment patch accepts only `{ "status": "accepted" }` or another permitted next status. To request customer action, provide `{ "status": "customer_action_required", "reason": "..." }`.
- Stores cannot change parent payment state or set a child to `cancelled`. Fulfilment updates are blocked until payment status is marked `paid` by a future verified-payment integration.

Sub-order transitions are restricted: pending_fulfilment -> accepted -> preparing -> ready_for_dispatch -> dispatched -> delivered; a store can instead move eligible early stages to customer_action_required or unable_to_fulfil. Terminal states cannot be reopened. Parent status is derived from child statuses only after verified payment.

## Reservation expiry and future exceptions

Unpaid orders reserve stock for `ORDER_RESERVATION_TTL_MINUTES` (default 15). The server sweeps every `ORDER_RESERVATION_SWEEP_SECONDS` (default 60), marks expired orders and children cancelled, and restores inventory transactionally. The worker is safe to run in multiple API processes because release and stock changes share a transaction.

The schemas include item fulfilment/refund fields and customer-action reason/decision timestamps for later substitution and refund workflows. No refund, customer decision, payment, or webhook is executed in this milestone. Fulfilment is intentionally blocked while every newly created order remains unpaid.

