import { Router } from "express";
import { Store } from "../models/Store.js";
import { Product } from "../models/Product.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";

const editableStoreFields = ["name", "category", "tagline", "description", "logoUrl", "coverImageUrl", "categories", "brandValues", "address", "openHours"];
const editableProductFields = ["name", "description", "category", "imageUrl", "priceKobo", "stockQuantity", "isAvailable"];

export function createStoresRouter({ StoreModel = Store, ProductModel = Product, authenticate = requireAuth, authorizeSupermarket = requireRoles("supermarket") } = {}) {
  const router = Router();

  router.get("/", asyncHandler(async (req, res) => {
    const filter = { isActive: true, isApproved: true };
    if (req.query.category) filter.category = String(req.query.category);
    if (req.query.q) filter.$text = { $search: String(req.query.q) };
    const stores = (await StoreModel.find(filter).sort({ name: 1 }).limit(100).lean()).map((store) => ({ ...store, id: store.slug }));
    res.json({ stores });
  }));

  router.get("/mine", authenticate, authorizeSupermarket, asyncHandler(async (req, res) => {
    const stores = (await StoreModel.find({ ownerUserId: req.auth.userId }).sort({ createdAt: -1 }).lean()).map((store) => ({
      id: store.slug,
      slug: store.slug,
      name: store.name,
      category: store.category,
      tagline: store.tagline,
      logoUrl: store.logoUrl,
      isActive: store.isActive,
      isApproved: store.isApproved,
      openHours: store.openHours,
    }));
    res.json({ stores });
  }));

  router.post("/", authenticate, authorizeSupermarket, asyncHandler(async (req, res) => {
    const auth = req.auth;
    const payload = Object.fromEntries(editableStoreFields.filter((key) => key in (req.body || {})).map((key) => [key, req.body[key]]));
    payload.slug = String(req.body?.slug || payload.name || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!payload.name || !payload.category || !payload.slug) return res.status(400).json({ error: { code: "INVALID_STORE", message: "Store name and category are required" } });
    payload.ownerUserId = auth.userId;
    payload.isApproved = false;
    payload.approvalStatus = "pending";
    payload.isActive = false;
    const store = await StoreModel.create(payload);
    res.status(201).json({ store });
  }));

  router.get("/:storeId", asyncHandler(async (req, res) => {
    const key = req.params.storeId;
    const query = /^[a-f\d]{24}$/i.test(key) ? { _id: key } : { slug: key.toLowerCase() };
    const storeDoc = await StoreModel.findOne({ ...query, isActive: true, isApproved: true }).lean();
    const store = storeDoc ? { ...storeDoc, id: storeDoc.slug } : null;
    if (!store) return res.status(404).json({ error: { code: "STORE_NOT_FOUND", message: "Store not found" } });
    res.json({ store });
  }));

  router.patch("/:storeId", authenticate, authorizeSupermarket, asyncHandler(async (req, res) => {
    const key = req.params.storeId;
    const storeKey = /^[a-f\d]{24}$/i.test(key) ? { _id: key } : { slug: key.toLowerCase() };
    const filter = activeOwnedStoreFilter(storeKey, req.auth.userId);
    const update = Object.fromEntries(editableStoreFields.filter((key) => key in (req.body || {})).map((key) => [key, req.body[key]]));
    const store = await StoreModel.findOneAndUpdate(filter, { $set: update }, { new: true, runValidators: true });
    if (!store) return res.status(404).json({ error: { code: "STORE_NOT_FOUND", message: "Store not found, inactive, unapproved, or not managed by this account" } });
    res.json({ store: { ...store.toObject(), id: store.slug } });
  }));

  router.get("/:storeId/products", asyncHandler(async (req, res) => {
    const key = req.params.storeId;
    const query = /^[a-f\d]{24}$/i.test(key) ? { _id: key } : { slug: key.toLowerCase() };
    const store = await StoreModel.findOne({ ...query, isActive: true, isApproved: true }).select("_id").lean();
    if (!store) return res.status(404).json({ error: { code: "STORE_NOT_FOUND", message: "Store not found" } });
    const filter = { storeId: store._id, isAvailable: true };
    if (req.query.category) filter.category = String(req.query.category);
    const products = (await ProductModel.find(filter).sort({ name: 1 }).limit(200).lean()).map((product) => ({ ...product, id: product.productKey }));
    res.json({ products });
  }));

  router.post("/:storeId/products", authenticate, authorizeSupermarket, asyncHandler(async (req, res) => {
    const key = req.params.storeId;
    const storeKey = /^[a-f\d]{24}$/i.test(key) ? { _id: key } : { slug: key.toLowerCase() };
    const store = await StoreModel.findOne(activeOwnedStoreFilter(storeKey, req.auth.userId)).select("_id").lean();
    if (!store) return res.status(404).json({ error: { code: "STORE_NOT_FOUND", message: "Store not found, inactive, unapproved, or not managed by this account" } });
    const body = req.body || {};
    if (!body.productKey || !body.name || !Number.isSafeInteger(body.priceKobo) || !Number.isSafeInteger(body.stockQuantity)) {
      return res.status(400).json({ error: { code: "INVALID_PRODUCT", message: "productKey, name, integer priceKobo, and integer stockQuantity are required" } });
    }
    const product = await ProductModel.create({ ...Object.fromEntries(editableProductFields.filter((key) => key in body).map((key) => [key, body[key]])), storeId: store._id, productKey: body.productKey });
    res.status(201).json({ product });
  }));

  router.patch("/:storeId/products/:productId", authenticate, authorizeSupermarket, asyncHandler(async (req, res) => {
    const key = req.params.storeId;
    const storeKey = /^[a-f\d]{24}$/i.test(key) ? { _id: key } : { slug: key.toLowerCase() };
    const store = await StoreModel.findOne(activeOwnedStoreFilter(storeKey, req.auth.userId)).select("_id").lean();
    if (!store) return res.status(404).json({ error: { code: "STORE_NOT_FOUND", message: "Store not found, inactive, unapproved, or not managed by this account" } });
    const update = Object.fromEntries(editableProductFields.filter((key) => key in (req.body || {})).map((key) => [key, req.body[key]]));
    const productKey = req.params.productId;
    const productQuery = /^[a-f\d]{24}$/i.test(productKey) ? { _id: productKey } : { productKey };
    const product = await ProductModel.findOneAndUpdate({ ...productQuery, storeId: store._id }, { $set: update }, { new: true, runValidators: true });
    if (!product) return res.status(404).json({ error: { code: "PRODUCT_NOT_FOUND", message: "Product not found" } });
    res.json({ product });
  }));

  return router;
}

function activeOwnedStoreFilter(storeKey, userId) {
  return {
    ...storeKey,
    ownerUserId: userId,
    isActive: true,
    isApproved: true,
    $or: [{ approvalStatus: "approved" }, { approvalStatus: { $exists: false } }],
  };
}

export const storesRouter = createStoresRouter();
