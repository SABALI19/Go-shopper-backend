# Rider delivery workflow

## Relationship and lifecycle

Each supermarket sub-order has at most one `Delivery` record (`subOrderId` is unique). This preserves one pickup and handover per store while keeping the delivery tied to its customer parent order. The supermarket marks a paid eligible sub-order `ready_for_dispatch`; that creates an unassigned delivery. An administrator assigns one approved, unsuspended, online rider with no active delivery. The rider accepts and arrives; the store confirms the physical handover; the rider starts the trip and completes it with the customer delivery code. Failed attempts remain in the delivery history and can be reassigned by an admin.

The rider profile holds an `activeDeliveryId` while an assignment is active. Assignment claims this field transactionally, so the same rider cannot be assigned to two open deliveries at once. Assignment and lifecycle events are retained for review.

## Rider account setup

An administrator provisions an existing Clerk user through `POST /api/admin/deliveries/riders/provision` with `{ "clerkUserId": "user_…", "vehicleType": "motorcycle" }`. The backend writes Clerk `publicMetadata.role = "rider"` and creates a pending rider profile. An admin approves the profile from the Rider accounts screen. The rider then signs out/in (or refreshes the Clerk session) to receive rider role routing, and can switch availability online.

## Endpoints

- `GET /api/rider/profile`, `PATCH /api/rider/availability`
- `GET /api/rider/deliveries`, `GET /api/rider/deliveries/:deliveryId`
- Rider `POST /api/rider/deliveries/:deliveryId/{accept,arrive,in-transit,fail,complete}` actions
- Customer `POST /api/orders/:orderId/deliveries/:deliveryId/code` issues an expiring code for an in-transit delivery
- Supermarket `POST /api/stores/:storeId/orders/:orderId/handover` confirms handover after rider arrival
- Admin `GET /api/admin/deliveries`, `GET /api/admin/deliveries/:deliveryId`, `POST /api/admin/deliveries/:deliveryId/assign`
- Admin rider management: `GET /api/admin/deliveries/riders/list`, `POST /api/admin/deliveries/riders/provision`, `PATCH /api/admin/deliveries/riders/:riderId/profile`

## Delivery code and boundaries

The backend generates a random six-digit code, stores only its SHA-256 hash, expires it after 15 minutes, allows at most five verification attempts, and rate limits issuance to three requests per 15-minute window. Only the authenticated customer who owns the parent order can request the code; it is returned only to that customer and never included in rider or admin responses. The customer displays the code to the rider in person. SMS/push delivery is not configured.

Tracking is status-based. This project has no maps/GPS integration or push-notification provider, so rider location and push notifications are not simulated. Admin assignment is manual. Failed deliveries after pickup can be reassigned while retaining pickup confirmation; a new rider can resume the trip without the store repeating handover.
