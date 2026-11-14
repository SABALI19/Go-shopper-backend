import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { errorHandler } from "../middleware/errors.js";
import { cancelPendingOrder, createParentOrder, expirePendingOrderReservations, fingerprintOrderRequest, isValidSubOrderTransition, validateCreateOrderRequest } from "../features/orders/service.js";
import { reportUnavailableItem } from "../features/orders/exceptions.js";
import { createOrdersRouter } from "./orders.js";
import { createStoreOrdersRouter } from "./storeOrders.js";

const storesSeed = [
  { _id: "store-db-a", slug: "alpha", name: "Alpha Supermarket", ownerUserId: "store-owner-a", isActive: true, isApproved: true },
  { _id: "store-db-b", slug: "beta", name: "Beta Supermarket", ownerUserId: "store-owner-b", isActive: true, isApproved: true },
];
const productsSeed = [
  { _id: "product-db-a", storeId: "store-db-a", productKey: "rice", name: "Rice", priceKobo: 900_000, stockQuantity: 5, isAvailable: true },
  { _id: "product-db-b", storeId: "store-db-b", productKey: "oil", name: "Oil", priceKobo: 900_000, stockQuantity: 5, isAvailable: true },
];

function query(getter) {
  let skip = 0;
  let limit = Infinity;
  return {
    session() { return this; },
    select() { return this; },
    sort() { return this; },
    skip(value) { skip = value; return this; },
    limit(value) { limit = value; return this; },
    lean() { return Promise.resolve(getter()).then((value) => Array.isArray(value) ? value.slice(skip, skip + limit) : value); },
    then(resolve, reject) { return Promise.resolve(getter()).then(resolve, reject); },
  };
}

function makeWorld() {
  const db = {
    stores: structuredClone(storesSeed),
    products: structuredClone(productsSeed),
    parents: [],
    children: [],
    nextId: 1,
    failSubOrderCreate: false,
    failProductUpdateId: null,
  };
  let queue = Promise.resolve();

  const StoreModel = {
    find(filter) {
      return query(() => db.stores.filter((store) => filter.$or.some((clause) =>
        (clause._id && String(clause._id) === String(store._id)) || (clause.slug && clause.slug === store.slug),
      )));
    },
    findOne(filter) {
      return query(() => db.stores.find((store) => filter.$or.some((clause) =>
        (clause._id && String(clause._id) === String(store._id)) || (clause.slug && clause.slug === store.slug),
      )) ?? null);
    },
  };

  const ProductModel = {
    find(filter) {
      return query(() => db.products.filter((product) => filter.$or.some((line) =>
        String(line.storeId) === String(product.storeId)
        && line.$or.some((id) =>
          (id._id && String(id._id) === String(product._id))
          || (id.productKey && id.productKey === product.productKey),
        ),
      )));
    },
    async updateOne(filter, update) {
      const product = db.products.find((entry) => String(entry._id) === String(filter._id)
        && String(entry.storeId) === String(filter.storeId)
        && (filter.isAvailable === undefined || entry.isAvailable === filter.isAvailable)
        && (filter.stockQuantity?.$gte === undefined || entry.stockQuantity >= filter.stockQuantity.$gte));
      if (!product) return { modifiedCount: 0 };
      if (product._id === db.failProductUpdateId) return { modifiedCount: 0 };
      product.stockQuantity += update.$inc?.stockQuantity ?? 0;
      Object.assign(product, update.$set ?? {});
      return { modifiedCount: 1 };
    },
  };

  function parentDocument(record) {
    const document = { ...record };
    Object.defineProperty(document, "save", {
      enumerable: false,
      value: async () => {
        const index = db.parents.findIndex((parent) => parent._id === record._id);
        if (index >= 0) db.parents[index] = Object.fromEntries(Object.entries(document).filter(([key]) => key !== "save"));
      },
    });
    return document;
  }

  const ParentOrderModel = {
    findOne(filter) {
      return query(() => {
        const record = db.parents.find((parent) => matches(parent, filter));
        return record ? parentDocument(record) : null;
      });
    },
    findById(id) { return query(() => db.parents.find((parent) => String(parent._id) === String(id)) ?? null); },
    find(filter) {
      return query(() => db.parents.filter((parent) => {
        if (filter._id?.$in && !filter._id.$in.some((id) => String(id) === String(parent._id))) return false;
        if (filter.customerUserId && parent.customerUserId !== filter.customerUserId) return false;
        if (filter.status && parent.status !== filter.status) return false;
        if (filter.paymentStatus && parent.paymentStatus !== filter.paymentStatus) return false;
        if (filter.reservationStatus && parent.reservationStatus !== filter.reservationStatus) return false;
        if (filter.reservationExpiresAt && parent.reservationExpiresAt > filter.reservationExpiresAt.$lte) return false;
        return true;
      }));
    },
    async countDocuments(filter) { return db.parents.filter((parent) => parent.customerUserId === filter.customerUserId).length; },
    async updateOne(filter, update) {
      const parent = db.parents.find((entry) => matches(entry, filter));
      if (!parent) return { modifiedCount: 0 };
      Object.assign(parent, update.$set);
      return { modifiedCount: 1 };
    },
    async create([input]) {
      const record = { ...structuredClone(input), _id: String(db.nextId++).padStart(24, "0"), createdAt: new Date(), updatedAt: new Date() };
      db.parents.push(record);
      return [parentDocument(record)];
    },
  };

  const SubOrderModel = {
    async create(inputs) {
      if (db.failSubOrderCreate) throw new Error("Injected sub-order persistence failure");
      const created = inputs.map((input) => ({ ...structuredClone(input), _id: `sub-${db.nextId++}`, createdAt: new Date(), updatedAt: new Date() }));
      db.children.push(...created);
      return created;
    },
    find(filter) {
      return query(() => db.children.filter((child) => {
        if (filter.parentOrderId && typeof filter.parentOrderId === "object" && filter.parentOrderId.$in) {
          return filter.parentOrderId.$in.some((id) => String(id) === String(child.parentOrderId));
        }
        if (filter.parentOrderId && String(filter.parentOrderId) !== String(child.parentOrderId)) return false;
        if (filter.storeId && String(filter.storeId) !== String(child.storeId)) return false;
        if (filter.status && child.status !== filter.status) return false;
        return true;
      }));
    },
    aggregate(pipeline) {
      const storeId = pipeline[0].$match.storeId;
      const counts = new Map();
      for (const child of db.children.filter((entry) => String(entry.storeId) === String(storeId))) {
        counts.set(child.status, (counts.get(child.status) ?? 0) + 1);
      }
      return Promise.resolve([...counts].map(([_id, count]) => ({ _id, count })));
    },
    findOne(filter) {
      return query(() => db.children.find((child) => matches(child, filter)) ?? null);
    },
    async updateOne(filter, update) {
      const child = db.children.find((entry) => matches(entry, filter));
      if (!child) return { modifiedCount: 0 };
      Object.assign(child, structuredClone(update.$set ?? {}));
      return { modifiedCount: 1 };
    },
    findOneAndUpdate(filter, update) {
      return query(() => {
        const child = db.children.find((entry) => matches(entry, filter));
        if (!child) return null;
        Object.assign(child, structuredClone(update.$set ?? {}));
        return child;
      });
    },
    async countDocuments(filter) { return db.children.filter((child) => String(child.storeId) === String(filter.storeId)).length; },
    async updateMany(filter, update) {
      const children = db.children.filter((child) => matches(child, filter));
      for (const child of children) {
        for (const [key, value] of Object.entries(update.$set)) {
          const parts = key.split(".");
          const leaf = parts.pop();
          const parent = parts.reduce((current, part) => current[part] ??= {}, child);
          parent[leaf] = value;
        }
      }
      return { modifiedCount: children.length };
    },
  };

  const connection = {
    async startSession() {
      return {
        async withTransaction(callback) {
          const prior = queue;
          let unlock;
          queue = new Promise((resolve) => { unlock = resolve; });
          await prior;
          const snapshot = structuredClone({ stores: db.stores, products: db.products, parents: db.parents, children: db.children, nextId: db.nextId });
          try {
            return await callback();
          } catch (error) {
            db.stores = snapshot.stores;
            db.products = snapshot.products;
            db.parents = snapshot.parents;
            db.children = snapshot.children;
            db.nextId = snapshot.nextId;
            throw error;
          } finally {
            unlock();
          }
        },
        async endSession() {},
      };
    },
  };

  return { db, StoreModel, ProductModel, ParentOrderModel, SubOrderModel, connection };
}

function matches(record, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === "object" && "$lte" in value) return record[key] <= value.$lte;
    if (value && typeof value === "object" && "$in" in value) return value.$in.some((entry) => String(entry) === String(record[key]));
    return String(record[key]) === String(value);
  });
}

const fees = { minimumStoreSubtotalKobo: 900_000, deliveryFeeKobo: 1_501, serviceFeeKobo: 100 };
const delivery = { fullName: "Ada Customer", address: "12 Market Road, Lagos", phone: "+2348012345678" };
const oneStoreItems = [{ storeId: "alpha", productId: "rice", quantity: 1 }];
const multiStoreItems = [
  { storeId: "alpha", productId: "rice", quantity: 1 },
  { storeId: "beta", productId: "oil", quantity: 1 },
];

function createInput(items = oneStoreItems, key = "request-key-0001", deliveryDetails = delivery) {
  return validateCreateOrderRequest({ items, delivery: deliveryDetails }, key);
}

async function serviceCreate(world, { items = oneStoreItems, key = "request-key-0001", customerId = "customer-a" } = {}) {
  const input = createInput(items, key);
  assert.equal(input.error, undefined);
  return createParentOrder({
    customerUserId: customerId,
    input,
    pricing: fees,
    reservationTtlMinutes: 15,
    ...world,
  });
}

async function request(app, { method = "GET", path, userId = "customer-a", body, idempotencyKey } = {}) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: {
        ...(userId ? { Authorization: `Bearer ${userId}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function storeRequest(app, options) {
  return request(app, { userId: "store-owner-a", ...options });
}

function ordersApp(world) {
  const app = express();
  app.use(express.json());
  app.use("/api/orders", createOrdersRouter({
    ...world,
    pricingProvider: () => fees,
    authenticate(req, res, next) {
      if (!req.headers.authorization) return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Sign in is required" } });
      req.auth = { userId: req.headers.authorization.replace("Bearer ", ""), role: "customer" };
      next();
    },
    authorizeCustomer(req, res, next) {
      if (req.auth?.role !== "customer") return res.status(403).json({ error: { code: "FORBIDDEN", message: "Customer role is required" } });
      next();
    },
  }));
  app.use(errorHandler);
  return app;
}

function storeOrdersApp(world, { userId = "store-owner-a", role = "supermarket" } = {}) {
  const app = express();
  app.use(express.json());
  app.use("/api/stores", createStoreOrdersRouter({
    ...world,
    authenticate(req, res, next) { req.auth = { userId: req.headers.authorization?.replace("Bearer ", "") ?? userId }; next(); },
    authorizeStore(req, res, next) {
      if (!["supermarket", "admin"].includes(role)) return res.status(403).json({ error: { code: "FORBIDDEN", message: "Store role required" } });
      next();
    },
    roleProvider: async () => role,
  }));
  app.use(errorHandler);
  return app;
}

async function paidMultiStoreOrder(world, key = `paid-order-${Math.random().toString(36).slice(2, 10)}`) {
  const { order } = await serviceCreate(world, { items: multiStoreItems, key });
  const parent = world.db.parents.find((entry) => entry.orderNumber === order.orderNumber);
  parent.paymentStatus = "paid";
  parent.status = "processing";
  for (const child of world.db.children.filter((entry) => entry.parentOrderId === parent._id)) child.status = "pending_fulfilment";
  return { order, parent, children: world.db.children.filter((entry) => entry.parentOrderId === parent._id) };
}

test("creates a single-store parent order with one pending-payment sub-order", async () => {
  const world = makeWorld();
  const result = await serviceCreate(world);
  assert.equal(result.order.status, "pending_payment");
  assert.equal(result.order.paymentStatus, "pending");
  assert.equal(result.order.subOrders.length, 1);
  assert.equal(result.order.subOrders[0].storeId, "alpha");
  assert.equal(result.order.subOrders[0].items[0].unitPriceKobo, 900_000);
  assert.equal(world.db.products[0].stockQuantity, 4);
  assert.equal(result.order.totalKobo, 901_601);
});

test("splits a multi-store checkout into one parent and one child per store", async () => {
  const world = makeWorld();
  const { order } = await serviceCreate(world, { items: multiStoreItems });
  assert.equal(world.db.parents.length, 1);
  assert.equal(world.db.children.length, 2);
  assert.equal(order.subOrders.length, 2);
  assert.equal(order.subOrders.reduce((sum, child) => sum + child.merchandiseSubtotalKobo, 0), 1_800_000);
  assert.equal(order.subOrders.reduce((sum, child) => sum + child.deliveryFeeKobo, 0), fees.deliveryFeeKobo);
  assert.equal(order.subOrders.reduce((sum, child) => sum + child.serviceFeeKobo, 0), fees.serviceFeeKobo);
});

test("enforces the minimum independently for each store and does not reserve on rejection", async () => {
  const world = makeWorld();
  world.db.products[1].priceKobo = 899_999;
  await assert.rejects(serviceCreate(world, { items: multiStoreItems }), (error) => error.apiCode === "MINIMUM_ORDER_NOT_MET");
  assert.equal(world.db.products[0].stockQuantity, 5);
  assert.equal(world.db.products[1].stockQuantity, 5);
  assert.equal(world.db.parents.length, 0);
});

test("uses current MongoDB prices when the mobile quote has become stale", async () => {
  const world = makeWorld();
  world.db.products[0].priceKobo = 1_050_000;
  const { order } = await serviceCreate(world);
  assert.equal(order.merchandiseSubtotalKobo, 1_050_000);
  assert.equal(order.subOrders[0].items[0].unitPriceKobo, 1_050_000);
});

test("rejects insufficient stock", async () => {
  const world = makeWorld();
  await assert.rejects(serviceCreate(world, { items: [{ storeId: "alpha", productId: "rice", quantity: 6 }] }), (error) => error.details.issues[0].code === "INSUFFICIENT_STOCK");
  assert.equal(world.db.products[0].stockQuantity, 5);
});

test("rejects a product submitted under the wrong store ID", async () => {
  const world = makeWorld();
  await assert.rejects(serviceCreate(world, { items: [{ storeId: "beta", productId: "rice", quantity: 1 }] }), (error) => error.details.issues[0].code === "PRODUCT_NOT_IN_STORE");
  assert.equal(world.db.products[0].stockQuantity, 5);
});

test("rolls back inventory and parent data if child-order persistence fails", async () => {
  const world = makeWorld();
  world.db.failSubOrderCreate = true;
  await assert.rejects(serviceCreate(world));
  assert.equal(world.db.products[0].stockQuantity, 5);
  assert.equal(world.db.parents.length, 0);
  assert.equal(world.db.children.length, 0);
});

test("reuses an idempotency key for the same request and rejects material changes", async () => {
  const world = makeWorld();
  const first = await serviceCreate(world);
  const retry = await serviceCreate(world);
  assert.equal(retry.reused, true);
  assert.equal(retry.order.orderNumber, first.order.orderNumber);
  assert.equal(world.db.parents.length, 1);
  assert.equal(world.db.products[0].stockQuantity, 4);
  await assert.rejects(serviceCreate(world, { key: "request-key-0001", items: [{ storeId: "alpha", productId: "rice", quantity: 2 }] }), (error) => error.apiCode === "IDEMPOTENCY_KEY_REUSED");
});

test("concurrent duplicate requests reserve stock and create orders once", async () => {
  const world = makeWorld();
  const results = await Promise.all([
    serviceCreate(world, { key: "concurrent-key-01" }),
    serviceCreate(world, { key: "concurrent-key-01" }),
  ]);
  assert.equal(new Set(results.map((result) => result.order.orderNumber)).size, 1);
  assert.equal(results.filter((result) => result.reused).length, 1);
  assert.equal(world.db.parents.length, 1);
  assert.equal(world.db.products[0].stockQuantity, 4);
});

test("different concurrent orders cannot oversell the last unit", async () => {
  const world = makeWorld();
  world.db.products[0].stockQuantity = 1;
  const outcomes = await Promise.allSettled([
    serviceCreate(world, { key: "last-unit-key-01" }),
    serviceCreate(world, { key: "last-unit-key-02" }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(world.db.parents.length, 1);
  assert.equal(world.db.products[0].stockQuantity, 0);
});

test("customer cancellation and reservation expiry both restore inventory exactly once", async () => {
  const world = makeWorld();
  const created = await serviceCreate(world, { key: "cancel-order-key" });
  const cancelled = await cancelPendingOrder({
    orderId: created.order.orderNumber,
    customerUserId: "customer-a",
    ...world,
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(world.db.products[0].stockQuantity, 5);
  await cancelPendingOrder({ orderId: created.order.orderNumber, customerUserId: "customer-a", ...world });
  assert.equal(world.db.products[0].stockQuantity, 5);

  const second = await serviceCreate(world, { key: "expire-order-key" });
  world.db.parents[1].reservationExpiresAt = new Date(0);
  const released = await expirePendingOrderReservations({ ...world, now: new Date() });
  assert.equal(released, 1);
  assert.equal(world.db.parents[1].status, "cancelled");
  assert.equal(world.db.products[0].stockQuantity, 5);
  assert.ok(second.order.orderNumber);
});

test("reservation expiry processes only expired unpaid held reservations", async () => {
  const world = makeWorld();
  await serviceCreate(world, { key: "expired-pending-order" });
  await serviceCreate(world, { key: "not-yet-expired-order" });
  await serviceCreate(world, { key: "already-paid-order" });
  world.db.parents[0].reservationExpiresAt = new Date(0);
  world.db.parents[1].reservationExpiresAt = new Date(Date.now() + 60_000);
  world.db.parents[2].reservationExpiresAt = new Date(0);
  world.db.parents[2].paymentStatus = "paid";

  const released = await expirePendingOrderReservations({ ...world, now: new Date() });

  assert.equal(released, 1);
  assert.equal(world.db.parents[0].reservationStatus, "released");
  assert.equal(world.db.parents[0].status, "cancelled");
  assert.equal(world.db.parents[1].reservationStatus, "held");
  assert.equal(world.db.parents[1].status, "pending_payment");
  assert.equal(world.db.parents[2].reservationStatus, "held");
  assert.equal(world.db.parents[2].status, "pending_payment");
  assert.equal(world.db.products[0].stockQuantity, 3);
});

test("requires authentication and rejects customer-supplied pricing on order creation", async () => {
  const world = makeWorld();
  const app = ordersApp(world);
  const unauthenticated = await request(app, { method: "POST", path: "/api/orders", userId: null, body: { items: oneStoreItems, delivery }, idempotencyKey: "request-key-0001" });
  assert.equal(unauthenticated.status, 401);
  const tampered = await request(app, { method: "POST", path: "/api/orders", body: { items: [{ ...oneStoreItems[0], unitPriceKobo: 1 }], delivery }, idempotencyKey: "request-key-0002" });
  assert.equal(tampered.status, 400);
  assert.equal(world.db.products[0].stockQuantity, 5);
});

test("customers cannot read another customer's parent order", async () => {
  const world = makeWorld();
  const { order } = await serviceCreate(world, { key: "customer-a-order" });
  const response = await request(ordersApp(world), { path: `/api/orders/${order.orderNumber}`, userId: "customer-b" });
  assert.equal(response.status, 404);
});

test("a store cannot read another store's sub-order", async () => {
  const world = makeWorld();
  const { order } = await serviceCreate(world, { key: "store-access-01" });
  const app = express();
  app.use("/api/stores", createStoreOrdersRouter({
    ...world,
    authenticate(req, res, next) { req.auth = { userId: "store-owner-b" }; next(); },
    authorizeStore(req, res, next) { next(); },
    roleProvider: async () => "supermarket",
  }));
  app.use(errorHandler);
  const response = await request(app, { path: `/api/stores/beta/orders/${order.subOrders[0].subOrderNumber}` });
  assert.equal(response.status, 404);
});

test("dashboard summary aggregates store-scoped counts and recent orders", async () => {
  const world = makeWorld();
  const first = await serviceCreate(world, { key: "dashboard-order-0001" });
  const second = await serviceCreate(world, { key: "dashboard-order-0002" });
  const third = await serviceCreate(world, { key: "dashboard-order-0003" });
  const fourth = await serviceCreate(world, { key: "dashboard-order-0004" });
  world.db.children.find((child) => child.subOrderNumber === second.order.subOrders[0].subOrderNumber).status = "accepted";
  world.db.children.find((child) => child.subOrderNumber === third.order.subOrders[0].subOrderNumber).status = "preparing";
  world.db.children.find((child) => child.subOrderNumber === fourth.order.subOrders[0].subOrderNumber).status = "delivered";

  const response = await request(storeOrdersApp(world), { path: "/api/stores/alpha/dashboard/summary", userId: "store-owner-a" });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.summary, {
    totalOrders: 4,
    pendingPaymentOrders: 1,
    awaitingFulfilmentOrders: 1,
    preparingOrders: 1,
    readyForDispatchOrders: 0,
    dispatchedOrders: 0,
    completedOrders: 1,
    cancelledOrders: 0,
    unableToFulfilOrders: 0,
    customerActionRequiredOrders: 0,
  });
  assert.equal(response.body.store.id, "alpha");
  assert.equal(response.body.recentOrders[0].itemCount, 1);
  assert.equal(response.body.recentOrders[0].paymentStatus, "pending");
  assert.equal(first.order.status, "pending_payment");
});

test("dashboard summary hides stores from another owner but permits admin access", async () => {
  const world = makeWorld();
  const ownerResponse = await request(storeOrdersApp(world), { path: "/api/stores/alpha/dashboard/summary", userId: "store-owner-b" });
  assert.equal(ownerResponse.status, 404);
  const adminResponse = await request(storeOrdersApp(world, { userId: "platform-admin", role: "admin" }), {
    path: "/api/stores/alpha/dashboard/summary",
    userId: "platform-admin",
  });
  assert.equal(adminResponse.status, 200);
});

test("store-order authorization does not block public customer store browsing", async () => {
  const world = makeWorld();
  const app = express();
  app.use("/api/stores", createStoreOrdersRouter({
    ...world,
    authenticate(req, res, next) { return res.status(401).json({ error: { code: "UNAUTHORIZED" } }); },
    authorizeStore(req, res, next) { return res.status(403).json({ error: { code: "FORBIDDEN" } }); },
  }));
  app.get("/api/stores", (req, res) => res.json({ stores: [] }));
  app.use(errorHandler);
  const response = await request(app, { path: "/api/stores", userId: null });
  assert.equal(response.status, 200);
});

test("status transitions are explicit and cannot be skipped", () => {
  assert.equal(isValidSubOrderTransition("pending_fulfilment", "accepted"), true);
  assert.equal(isValidSubOrderTransition("pending_fulfilment", "delivered"), false);
  assert.equal(isValidSubOrderTransition("delivered", "preparing"), false);
});

test("fingerprint ignores item order but includes delivery changes", () => {
  const items = multiStoreItems;
  assert.equal(fingerprintOrderRequest(items, delivery), fingerprintOrderRequest([...items].reverse(), delivery));
  assert.notEqual(fingerprintOrderRequest(items, delivery), fingerprintOrderRequest(items, { ...delivery, address: "Different address" }));
});

test("store reports an individual unavailable item, preserves snapshot, and records exact pending refund", async () => {
  const world = makeWorld();
  const { order, children } = await paidMultiStoreOrder(world);
  const alpha = children.find((child) => child.storeSlug === "alpha");
  const original = structuredClone(alpha.items[0]);
  const response = await storeRequest(storeOrdersApp(world), {
    method: "POST",
    path: `/api/stores/alpha/orders/${alpha.subOrderNumber}/items/rice/unavailable`,
    body: { reason: "Damaged during shelf check" },
  });
  assert.equal(response.status, 200);
  const saved = world.db.children.find((child) => child._id === alpha._id);
  assert.equal(saved.items[0].fulfilmentStatus, "unavailable");
  assert.equal(saved.items[0].unitPriceKobo, original.unitPriceKobo);
  assert.equal(saved.items[0].lineTotalKobo, original.lineTotalKobo);
  assert.equal(saved.items[0].refundAmountKobo, original.lineTotalKobo);
  assert.equal(saved.items[0].refundStatus, "pending");
  assert.equal(world.db.parents[0].refundObligations[0].amountKobo, original.lineTotalKobo);
  assert.equal(world.db.parents[0].refundObligations[0].status, "pending");
  assert.equal(world.db.products[0].stockQuantity, 5);
  assert.equal(world.db.products[0].isAvailable, false);
  assert.equal(response.body.item.remainingMerchandiseKobo, 0);
});

test("store cannot report an item on another supermarket's sub-order", async () => {
  const world = makeWorld();
  const { children } = await paidMultiStoreOrder(world);
  const beta = children.find((child) => child.storeSlug === "beta");
  const response = await storeRequest(storeOrdersApp(world), {
    method: "POST",
    path: `/api/stores/alpha/orders/${beta.subOrderNumber}/items/oil/unavailable`,
    body: { reason: "Out of stock" },
  });
  assert.equal(response.status, 404);
  assert.equal(world.db.parents[0].refundObligations, undefined);
});

test("duplicate unavailable item reports are rejected without duplicate obligations", async () => {
  const world = makeWorld();
  const { children } = await paidMultiStoreOrder(world);
  const alpha = children.find((child) => child.storeSlug === "alpha");
  const app = storeOrdersApp(world);
  const path = `/api/stores/alpha/orders/${alpha.subOrderNumber}/items/rice/unavailable`;
  const first = await storeRequest(app, { method: "POST", path, body: { reason: "Not saleable" } });
  const second = await storeRequest(app, { method: "POST", path, body: { reason: "Still not saleable" } });
  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
  assert.equal(world.db.parents[0].refundObligations.length, 1);
});

test("unavailable item keeps other products eligible for normal fulfilment", async () => {
  const world = makeWorld();
  world.db.products.push({ _id: "product-db-a2", storeId: "store-db-a", productKey: "tea", name: "Tea", priceKobo: 10_000, stockQuantity: 4, isAvailable: true });
  const { order } = await serviceCreate(world, { items: [{ storeId: "alpha", productId: "rice", quantity: 1 }, { storeId: "alpha", productId: "tea", quantity: 1 }] });
  const parent = world.db.parents[0];
  parent.paymentStatus = "paid";
  parent.status = "processing";
  const child = world.db.children[0];
  child.status = "pending_fulfilment";
  const app = storeOrdersApp(world);
  const report = await storeRequest(app, { method: "POST", path: `/api/stores/alpha/orders/${child.subOrderNumber}/items/rice/unavailable`, body: { reason: "Package is damaged" } });
  assert.equal(report.status, 200);
  assert.equal(child.items.find((item) => item.productKey === "tea").fulfilmentStatus, "pending");
  const transition = await storeRequest(app, { method: "PATCH", path: `/api/stores/alpha/orders/${child.subOrderNumber}/fulfillment`, body: { status: "accepted" } });
  assert.equal(transition.status, 200);
  assert.equal(world.db.children[0].status, "accepted");
  assert.equal(order.subOrders[0].items.length, 2);
});

test("store requires a reason and cannot file an exception on an unpaid order", async () => {
  const world = makeWorld();
  const { order, children } = await paidMultiStoreOrder(world);
  const alpha = children.find((child) => child.storeSlug === "alpha");
  world.db.parents[0].paymentStatus = "pending";
  const app = storeOrdersApp(world);
  const noReason = await storeRequest(app, { method: "POST", path: `/api/stores/alpha/orders/${alpha.subOrderNumber}/unable-to-fulfil`, body: {} });
  assert.equal(noReason.status, 400);
  const unpaid = await storeRequest(app, { method: "POST", path: `/api/stores/alpha/orders/${alpha.subOrderNumber}/items/rice/unavailable`, body: { reason: "Not on shelf" } });
  assert.equal(unpaid.status, 409);
  const fulfilment = await storeRequest(app, { method: "PATCH", path: `/api/stores/alpha/orders/${alpha.subOrderNumber}/fulfillment`, body: { status: "accepted" } });
  assert.equal(fulfilment.status, 409);
  assert.equal(world.db.parents[0].refundObligations, undefined);
  assert.ok(order.orderNumber);
});

test("customer can retrieve a store inability request and approve continuation with pending refund obligation", async () => {
  const world = makeWorld();
  const { order, children } = await paidMultiStoreOrder(world);
  const alpha = children.find((child) => child.storeSlug === "alpha");
  const stores = storeOrdersApp(world);
  const requestAction = await storeRequest(stores, { method: "POST", path: `/api/stores/alpha/orders/${alpha.subOrderNumber}/unable-to-fulfil`, body: { reason: "Cold storage failure" } });
  assert.equal(requestAction.status, 200);
  assert.equal(alpha.status, "customer_action_required");
  assert.equal(world.db.parents[0].status, "customer_action_required");
  assert.equal(requestAction.body.action.customerAction.amountKobo, alpha.totalKobo);

  const app = ordersApp(world);
  const getAction = await request(app, { path: `/api/orders/${order.orderNumber}/customer-action` });
  assert.equal(getAction.status, 200);
  assert.equal(getAction.body.action.affectedStoreName, "Alpha Supermarket");
  assert.equal(getAction.body.action.reason, "Cold storage failure");
  const approve = await request(app, { method: "POST", path: `/api/orders/${order.orderNumber}/customer-action/decision`, body: { decision: "proceed_remaining" } });
  assert.equal(approve.status, 200);
  assert.equal(approve.body.order.status, "partially_fulfilled");
  assert.equal(approve.body.order.subOrders.find((child) => child.storeId === "alpha").status, "cancelled");
  assert.equal(approve.body.order.subOrders.find((child) => child.storeId === "beta").status, "pending_fulfilment");
  assert.equal(approve.body.order.customerAction.decision, "proceed_remaining");
  assert.equal(approve.body.order.refundObligations[0].amountKobo, alpha.totalKobo);
  assert.equal(approve.body.order.refundObligations[0].status, "pending");
  assert.equal(approve.body.order.paymentStatus, "paid");
});

test("customer rejection cancels remaining sub-orders and records obligations once", async () => {
  const world = makeWorld();
  const { order, children } = await paidMultiStoreOrder(world);
  const alpha = children.find((child) => child.storeSlug === "alpha");
  await storeRequest(storeOrdersApp(world), { method: "POST", path: `/api/stores/alpha/orders/${alpha.subOrderNumber}/unable-to-fulfil`, body: { reason: "Store closed unexpectedly" } });
  const app = ordersApp(world);
  const reject = await request(app, { method: "POST", path: `/api/orders/${order.orderNumber}/customer-action/decision`, body: { decision: "cancel_remaining" } });
  assert.equal(reject.status, 200);
  assert.equal(reject.body.order.status, "cancelled");
  assert.ok(reject.body.order.subOrders.every((child) => child.status === "cancelled"));
  assert.equal(reject.body.order.refundObligations.reduce((sum, entry) => sum + entry.amountKobo, 0), order.totalKobo);
  assert.ok(reject.body.order.refundObligations.every((entry) => entry.status === "pending"));
  assert.equal(world.db.products[0].stockQuantity, 5);
  assert.equal(world.db.products[1].stockQuantity, 5);
});

test("customer decisions are owner-scoped, idempotent for same choice, and cannot be changed", async () => {
  const world = makeWorld();
  const { order, children } = await paidMultiStoreOrder(world);
  const alpha = children.find((child) => child.storeSlug === "alpha");
  await storeRequest(storeOrdersApp(world), { method: "POST", path: `/api/stores/alpha/orders/${alpha.subOrderNumber}/unable-to-fulfil`, body: { reason: "Cannot staff the order" } });
  const app = ordersApp(world);
  const otherCustomer = await request(app, { path: `/api/orders/${order.orderNumber}/customer-action`, userId: "customer-b" });
  assert.equal(otherCustomer.status, 404);
  const otherDecision = await request(app, { method: "POST", path: `/api/orders/${order.orderNumber}/customer-action/decision`, userId: "customer-b", body: { decision: "cancel_remaining" } });
  assert.equal(otherDecision.status, 404);
  const decisionBody = { decision: "proceed_remaining" };
  const first = await request(app, { method: "POST", path: `/api/orders/${order.orderNumber}/customer-action/decision`, body: decisionBody });
  const retry = await request(app, { method: "POST", path: `/api/orders/${order.orderNumber}/customer-action/decision`, body: decisionBody });
  const changed = await request(app, { method: "POST", path: `/api/orders/${order.orderNumber}/customer-action/decision`, body: { decision: "cancel_remaining" } });
  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.equal(world.db.parents[0].refundObligations.length, 1);
  assert.equal(changed.status, 409);
});

test("transaction failure while releasing an unavailable reservation leaves order and refund data unchanged", async () => {
  const world = makeWorld();
  const { children } = await paidMultiStoreOrder(world);
  const alpha = children.find((child) => child.storeSlug === "alpha");
  const beforeStock = world.db.products[0].stockQuantity;
  world.db.products = world.db.products.filter((product) => product._id !== "product-db-a");
  await assert.rejects(reportUnavailableItem({ storeDbId: "store-db-a", subOrderId: alpha.subOrderNumber, productId: "rice", reason: "Out of stock", ...world }), (error) => error.apiCode === "RESERVATION_RELEASE_FAILED");
  assert.equal(world.db.children.find((child) => child._id === alpha._id).items[0].fulfilmentStatus, "pending");
  assert.equal(world.db.parents[0].refundObligations, undefined);
  assert.equal(world.db.products.some((product) => product.stockQuantity > beforeStock), false);
});

test("failed customer-decision transaction rolls back earlier child and inventory writes", async () => {
  const world = makeWorld();
  const { order, children } = await paidMultiStoreOrder(world);
  const alpha = children.find((child) => child.storeSlug === "alpha");
  await storeRequest(storeOrdersApp(world), { method: "POST", path: `/api/stores/alpha/orders/${alpha.subOrderNumber}/unable-to-fulfil`, body: { reason: "Cold room failure" } });
  world.db.failProductUpdateId = "product-db-b";
  const response = await request(ordersApp(world), { method: "POST", path: `/api/orders/${order.orderNumber}/customer-action/decision`, body: { decision: "cancel_remaining" } });
  assert.equal(response.status, 409);
  assert.equal(world.db.products.find((product) => product._id === "product-db-a").stockQuantity, 4);
  assert.equal(world.db.children.find((child) => child.storeSlug === "alpha").status, "customer_action_required");
  assert.equal(world.db.children.find((child) => child.storeSlug === "beta").status, "pending_fulfilment");
  assert.equal(world.db.parents[0].customerAction.decision, "pending");
  assert.equal(world.db.parents[0].refundObligations, undefined);
});
