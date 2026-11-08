import { Router } from "express";
import { getAuth } from "@clerk/express";
import { Store } from "../models/Store.js";
import { Product } from "../models/Product.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { getUserRole, requireAuth, requireRoles } from "../middleware/auth.js";

export const storesRouter = Router();
const editableStoreFields = ["name", "category", "tagline", "description", "logoUrl", "coverImageUrl", "categories", "brandValues", "address", "openHours"];
const editableProductFields = ["name", "description", "category", "imageUrl", "priceKobo", "stockQuantity", "isAvailable"];

storesRouter.get("/", asyncHandler(async (req, res) => {
  const filter = { isActive: true, isApproved: true };
  if (req.query.category) filter.category = String(req.query.category);
  if (req.query.q) filter.$text = { $search: String(req.query.q) };
  const stores = (await Store.find(filter).sort({ name: 1 }).limit(100).lean()).map((store) => ({ ...store, id: store.slug }));
  res.json({ stores });
}));
storesRouter.get("/mine", requireAuth, asyncHandler(async (req, res) => {
  const auth = req.auth || getAuth(req);
  const role = await getUserRole(auth);
  const filter = role === "admin" ? {} : { ownerClerkUserId: auth.userId };
  const stores = (await Store.find(filter).sort({ createdAt: -1 }).lean()).map((store) => ({
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

storesRouter.post("/", requireAuth, requireRoles("supermarket", "admin"), asyncHandler(async (req, res) => {
  const auth = req.auth || getAuth(req);
  const payload = Object.fromEntries(editableStoreFields.filter((key) => key in (req.body || {})).map((key) => [key, req.body[key]]));
  payload.slug = String(req.body?.slug || payload.name || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!payload.name || !payload.category || !payload.slug) return res.status(400).json({ error: { code: "INVALID_STORE", message: "Store name and category are required" } });
  payload.ownerClerkUserId = auth.userId;
  payload.isApproved = await getUserRole(auth) === "admin";
  payload.approvalStatus = payload.isApproved ? "approved" : "pending";
  const store = await Store.create(payload);
  res.status(201).json({ store });
}));

storesRouter.get("/:storeId", asyncHandler(async (req, res) => {
  const key = req.params.storeId;
  const query = /^[a-f\d]{24}$/i.test(key) ? { _id: key } : { slug: key.toLowerCase() };
  const storeDoc = await Store.findOne({ ...query, isActive: true, isApproved: true }).lean();
  const store = storeDoc ? { ...storeDoc, id: storeDoc.slug } : null;
  if (!store) return res.status(404).json({ error: { code: "STORE_NOT_FOUND", message: "Store not found" } });
  res.json({ store });
}));

storesRouter.patch("/:storeId", requireAuth, asyncHandler(async (req, res) => {
  const auth = req.auth || getAuth(req);
  const role = await getUserRole(auth);
  const key = req.params.storeId;
  const storeKey = /^[a-f\d]{24}$/i.test(key) ? { _id: key } : { slug: key.toLowerCase() };
  const filter = { ...storeKey, ...(role === "admin" ? {} : { ownerClerkUserId: auth.userId }) };
  const update = Object.fromEntries(editableStoreFields.filter((key) => key in (req.body || {})).map((key) => [key, req.body[key]]));
  const store = await Store.findOneAndUpdate(filter, { $set: update }, { new: true, runValidators: true });
  if (!store) return res.status(404).json({ error: { code: "STORE_NOT_FOUND", message: "Store not found or you do not manage it" } });
  res.json({ store: { ...store.toObject(), id: store.slug } });
}));

storesRouter.get("/:storeId/products", asyncHandler(async (req, res) => {
  const key = req.params.storeId;
  const query = /^[a-f\d]{24}$/i.test(key) ? { _id: key } : { slug: key.toLowerCase() };
  const store = await Store.findOne({ ...query, isActive: true, isApproved: true }).select("_id").lean();
  if (!store) return res.status(404).json({ error: { code: "STORE_NOT_FOUND", message: "Store not found" } });
  const filter = { storeId: store._id, isAvailable: true };
  if (req.query.category) filter.category = String(req.query.category);
  const products = (await Product.find(filter).sort({ name: 1 }).limit(200).lean()).map((product) => ({ ...product, id: product.productKey }));
  res.json({ products });
}));

storesRouter.post("/:storeId/products", requireAuth, asyncHandler(async (req, res) => {
  const auth = req.auth || getAuth(req);
  const role = await getUserRole(auth);
  const key = req.params.storeId;
  const storeKey = /^[a-f\d]{24}$/i.test(key) ? { _id: key } : { slug: key.toLowerCase() };
  const store = await Store.findOne({ ...storeKey, ...(role === "admin" ? {} : { ownerClerkUserId: auth.userId }) }).select("_id").lean();
  if (!store) return res.status(404).json({ error: { code: "STORE_NOT_FOUND", message: "Store not found or you do not manage it" } });
  const body = req.body || {};
  if (!body.productKey || !body.name || !Number.isSafeInteger(body.priceKobo) || !Number.isSafeInteger(body.stockQuantity)) {
    return res.status(400).json({ error: { code: "INVALID_PRODUCT", message: "productKey, name, integer priceKobo, and integer stockQuantity are required" } });
  }
  const product = await Product.create({ ...Object.fromEntries(editableProductFields.filter((key) => key in body).map((key) => [key, body[key]])), storeId: store._id, productKey: body.productKey });
  res.status(201).json({ product });
}));

storesRouter.patch("/:storeId/products/:productId", requireAuth, asyncHandler(async (req, res) => {
  const auth = req.auth || getAuth(req);
  const role = await getUserRole(auth);
  const key = req.params.storeId;
  const storeKey = /^[a-f\d]{24}$/i.test(key) ? { _id: key } : { slug: key.toLowerCase() };
  const store = await Store.findOne({ ...storeKey, ...(role === "admin" ? {} : { ownerClerkUserId: auth.userId }) }).select("_id").lean();
  if (!store) return res.status(404).json({ error: { code: "STORE_NOT_FOUND", message: "Store not found or you do not manage it" } });
  const update = Object.fromEntries(editableProductFields.filter((key) => key in (req.body || {})).map((key) => [key, req.body[key]]));
  const productKey = req.params.productId;
  const productQuery = /^[a-f\d]{24}$/i.test(productKey) ? { _id: productKey } : { productKey };
  const product = await Product.findOneAndUpdate({ ...productQuery, storeId: store._id }, { $set: update }, { new: true, runValidators: true });
  if (!product) return res.status(404).json({ error: { code: "PRODUCT_NOT_FOUND", message: "Product not found" } });
  res.json({ product });
}));
