import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { createStoresRouter } from "./stores.js";

async function request(app, method, path, user, body = {}) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const options = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (method !== "GET" && method !== "HEAD") options.body = JSON.stringify(body);
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function appWith({ user, storeResult = null } = {}) {
  let lastStoreFilter;
  const StoreModel = {
    find(filter) { lastStoreFilter = filter; return { sort() { return this; }, lean: async () => [] }; },
    findOne(filter) { lastStoreFilter = filter; return { select() { return this; }, lean: async () => storeResult }; },
    findOneAndUpdate(filter) { lastStoreFilter = filter; return Promise.resolve(null); },
    async create() { throw new Error("Unexpected store creation"); },
  };
  const ProductModel = {
    async create() { throw new Error("Product must not be created for rejected requests"); },
    findOneAndUpdate() { throw new Error("Product must not be updated for rejected requests"); },
  };
  const authenticate = (req, _res, next) => { req.auth = { userId: String(user._id), role: user.role, user }; next(); };
  const app = express();
  app.use(express.json());
  app.use("/api/stores", createStoresRouter({ StoreModel, ProductModel, authenticate }));
  return { app, getLastStoreFilter: () => lastStoreFilter };
}

test("pending supermarket account cannot mutate its store profile", async () => {
  const user = { _id: "pending-owner", role: "supermarket", approvalStatus: "pending", isSuspended: false };
  const { app } = appWith({ user });
  const response = await request(app, "PATCH", "/api/stores/shop-one", user, { name: "Changed" });
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "APPROVAL_REQUIRED");
});

test("non-supermarket account cannot create a product", async () => {
  const user = { _id: "customer-user", role: "customer", approvalStatus: "approved", isSuspended: false };
  const { app } = appWith({ user });
  const response = await request(app, "POST", "/api/stores/shop-one/products", user, { productKey: "one", name: "Item", priceKobo: 100, stockQuantity: 1 });
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "FORBIDDEN");
});

test("store profile and product mutations cannot cross owner boundaries", async () => {
  const user = { _id: "owner-two", role: "supermarket", approvalStatus: "approved", isSuspended: false };
  const { app, getLastStoreFilter } = appWith({ user });
  const response = await request(app, "PATCH", "/api/stores/shop-one/products/product-one", user, { priceKobo: 250 });
  assert.equal(response.status, 404);
  assert.equal(getLastStoreFilter().ownerUserId, "owner-two");
  assert.equal(getLastStoreFilter().isActive, true);
  assert.equal(getLastStoreFilter().isApproved, true);
});

test("admin cannot use the supermarket-owned stores endpoint", async () => {
  const user = { _id: "admin-user", role: "admin", approvalStatus: "approved", isSuspended: false };
  const { app } = appWith({ user });
  const response = await request(app, "GET", "/api/stores/mine", user);
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "FORBIDDEN");
});
