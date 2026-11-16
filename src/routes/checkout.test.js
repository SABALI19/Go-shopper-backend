import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { createCheckoutRouter } from "./checkout.js";

const storeAId = "64b000000000000000000001";
const storeBId = "64b000000000000000000002";
const productAId = "64b000000000000000000101";
const productBId = "64b000000000000000000102";

const baseStores = [
  { _id: storeAId, slug: "alpha-market", name: "Alpha Market", isOpen: true, isSuspended: false, isApproved: true, approvalStatus: "approved" },
  { _id: storeBId, slug: "beta-market", name: "Beta Market", isOpen: true, isSuspended: false, isApproved: true, approvalStatus: "approved" },
];

const baseProducts = [
  { _id: productAId, storeId: storeAId, productKey: "rice", name: "Rice", priceKobo: 900_000, stockQuantity: 10, isAvailable: true },
  { _id: productBId, storeId: storeBId, productKey: "oil", name: "Oil", priceKobo: 500_000, stockQuantity: 10, isAvailable: true },
];

function queryResult(value) {
  return {
    select() { return this; },
    lean() { return Promise.resolve(value); },
  };
}

function createTestModels({ stores = baseStores, products = baseProducts } = {}) {
  return {
    StoreModel: {
      find(filter) {
        const found = stores.filter((store) => filter.$or.some((clause) =>
          (clause._id && String(clause._id) === String(store._id))
          || (clause.slug && clause.slug === store.slug),
        ));
        return queryResult(found);
      },
    },
    ProductModel: {
      find(filter) {
        const found = products.filter((product) => filter.$or.some((clause) => {
          if (String(clause.storeId) !== String(product.storeId)) return false;
          return clause.$or.some((identifier) =>
            (identifier._id && String(identifier._id) === String(product._id))
            || (identifier.productKey && identifier.productKey === product.productKey),
          );
        }));
        return queryResult(found);
      },
    },
  };
}

async function quote(items, { authorization = "Bearer test-customer", role = "customer", extraModels = {} } = {}) {
  const models = createTestModels(extraModels);
  const app = express();
  app.use(express.json());
  app.use("/api/checkout", createCheckoutRouter({
    ...models,
    authenticate(req, res, next) {
      if (!req.headers.authorization) {
        return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Sign in is required" } });
      }
      req.auth = { userId: "test-user", role };
      next();
    },
    authorizeCustomer(req, res, next) {
      if (req.auth?.role !== "customer") {
        return res.status(403).json({ error: { code: "FORBIDDEN", message: "Customer role is required" } });
      }
      next();
    },
    pricingProvider: () => ({ multiStoreCheckoutMinimumKobo: 900_000, deliveryFeeKobo: 12_000, serviceFeeKobo: 3_000 }),
  }));
  const response = await new Promise((resolve, reject) => {
    const localServer = app.listen(0, "127.0.0.1", async () => {
      try {
        const address = localServer.address();
        const result = await fetch(`http://127.0.0.1:${address.port}/api/checkout/quote`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) },
          body: JSON.stringify({ items }),
        });
        resolve({ status: result.status, body: await result.json() });
      } catch (error) {
        reject(error);
      } finally {
        localServer.close();
      }
    });
  });
  return response;
}

test("allows a tiny subtotal from a single store", async () => {
  const result = await quote([{ storeId: "alpha-market", productId: "rice", quantity: 1 }], {
    extraModels: { products: [{ ...baseProducts[0], priceKobo: 1 }] },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.quote.merchandiseSubtotalKobo, 1);
  assert.equal(result.body.quote.storeCount, 1);
  assert.equal(result.body.quote.isMultiStore, false);
  assert.equal(result.body.quote.isEligible, true);
  assert.equal(result.body.quote.amountRemainingKobo, 0);
  assert.equal(result.body.quote.deliveryFeeKobo, 12_000);
  assert.equal(result.body.quote.serviceFeeKobo, 3_000);
});

test("rejects a two-store quote below the combined minimum and excludes fees", async () => {
  const result = await quote([{ storeId: "alpha-market", productId: "rice", quantity: 1 }, { storeId: "beta-market", productId: "oil", quantity: 1 }], {
    extraModels: { products: [{ ...baseProducts[0], priceKobo: 400_000 }, { ...baseProducts[1], priceKobo: 499_999 }] },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.quote.multiStoreMinimumKobo, 900_000);
  assert.equal(result.body.quote.merchandiseSubtotalKobo, 899_999);
  assert.equal(result.body.quote.storeCount, 2);
  assert.equal(result.body.quote.isMultiStore, true);
  assert.equal(result.body.quote.isEligible, false);
  assert.equal(result.body.quote.amountRemainingKobo, 1);
});

test("allows two stores totaling exactly the combined minimum", async () => {
  const result = await quote([{ storeId: "alpha-market", productId: "rice", quantity: 1 }, { storeId: "beta-market", productId: "oil", quantity: 1 }], {
    extraModels: { products: [{ ...baseProducts[0], priceKobo: 400_000 }, { ...baseProducts[1], priceKobo: 500_000 }] },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.quote.merchandiseSubtotalKobo, 900_000);
  assert.equal(result.body.quote.isEligible, true);
  assert.equal(result.body.quote.amountRemainingKobo, 0);
});

test("allows two stores above the combined minimum using live database prices", async () => {
  const result = await quote([
    { storeId: "alpha-market", productId: "rice", quantity: 1 },
    { storeId: "beta-market", productId: "oil", quantity: 2 },
  ]);
  assert.equal(result.status, 200);
  assert.equal(result.body.quote.stores.length, 2);
  assert.equal(result.body.quote.isEligible, true);
  assert.equal(result.body.quote.isMultiStore, true);
  assert.equal(result.body.quote.merchandiseSubtotalKobo, 1_900_000);
  assert.equal(result.body.quote.totalKobo, 1_915_000);
});

test("rejects unavailable products without substituting them", async () => {
  const result = await quote([{ storeId: "alpha-market", productId: "rice", quantity: 1 }], {
    extraModels: { products: [{ ...baseProducts[0], isAvailable: false }] },
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.issues[0].code, "PRODUCT_UNAVAILABLE");
});

test("rejects insufficient stock with available quantity", async () => {
  const result = await quote([{ storeId: "alpha-market", productId: "rice", quantity: 11 }]);
  assert.equal(result.status, 409);
  assert.equal(result.body.issues[0].code, "INSUFFICIENT_STOCK");
  assert.equal(result.body.issues[0].availableQuantity, 10);
});

test("does not resolve a product under a different supermarket", async () => {
  const result = await quote([{ storeId: "beta-market", productId: "rice", quantity: 1 }]);
  assert.equal(result.status, 409);
  assert.equal(result.body.issues[0].code, "PRODUCT_NOT_IN_STORE");
});

test("rejects closed, suspended, or unapproved supermarkets", async () => {
  for (const storeOverride of [{ isOpen: false }, { isSuspended: true }, { isApproved: false }]) {
    const result = await quote([{ storeId: "alpha-market", productId: "rice", quantity: 1 }], {
      extraModels: { stores: [{ ...baseStores[0], ...storeOverride }, baseStores[1]] },
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.issues[0].code, "STORE_UNAVAILABLE");
  }
});

test("requires authentication", async () => {
  const result = await quote([{ storeId: "alpha-market", productId: "rice", quantity: 1 }], { authorization: "" });
  assert.equal(result.status, 401);
  assert.equal(result.body.error.code, "UNAUTHORIZED");
});

test("rejects authenticated non-customer roles", async () => {
  const result = await quote([{ storeId: "alpha-market", productId: "rice", quantity: 1 }], { role: "supermarket" });
  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, "FORBIDDEN");
});

test("rejects client-submitted prices instead of trusting them", async () => {
  const result = await quote([{ storeId: "alpha-market", productId: "rice", quantity: 1, unitPriceKobo: 1 }]);
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, "INVALID_CHECKOUT_REQUEST");
});

test("rejects malformed quantities", async () => {
  const result = await quote([{ storeId: "alpha-market", productId: "rice", quantity: 1.5 }]);
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, "INVALID_CHECKOUT_REQUEST");
});
