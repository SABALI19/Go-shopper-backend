import mongoose from "mongoose";

const objectIdPattern = /^[a-f\d]{24}$/i;

export function storeLookup(identifier) {
  return objectIdPattern.test(identifier)
    ? [{ _id: new mongoose.Types.ObjectId(identifier) }, { slug: identifier.toLowerCase() }]
    : [{ slug: identifier.toLowerCase() }];
}

function productLookup(identifier) {
  return objectIdPattern.test(identifier)
    ? [{ _id: new mongoose.Types.ObjectId(identifier) }, { productKey: identifier }]
    : [{ productKey: identifier }];
}

function withSession(query, session) {
  return session ? query.session(session) : query;
}

export async function resolveCartItems({ items, StoreModel, ProductModel, session }) {
  const requestedStoreIds = [...new Set(items.map((item) => item.storeId))];
  const storeFilters = requestedStoreIds.flatMap(storeLookup);
  const stores = await withSession(StoreModel.find({ $or: storeFilters }), session)
    .select("_id slug name isActive isApproved ownerUserId")
    .lean();
  const storeByRequestedId = new Map();
  const issues = [];

  for (const requestedId of requestedStoreIds) {
    const storeByMongoId = objectIdPattern.test(requestedId)
      ? stores.find((candidate) => String(candidate._id).toLowerCase() === requestedId.toLowerCase())
      : null;
    const store = storeByMongoId ?? stores.find((candidate) => candidate.slug === requestedId.toLowerCase());
    if (!store) {
      issues.push({ storeId: requestedId, code: "STORE_NOT_FOUND", message: "This supermarket could not be found." });
    } else if (!store.isActive || !store.isApproved) {
      issues.push({ storeId: requestedId, code: "STORE_UNAVAILABLE", message: "This supermarket is not currently available for checkout." });
    } else {
      storeByRequestedId.set(requestedId, store);
    }
  }
  if (issues.length) return { items: [], issues };

  const productFilters = items.map((item) => ({
    storeId: storeByRequestedId.get(item.storeId)._id,
    $or: productLookup(item.productId),
  }));
  const products = await withSession(ProductModel.find({ $or: productFilters }), session)
    .select("_id storeId productKey name description imageUrl priceKobo stockQuantity isAvailable")
    .lean();
  const verifiedItems = [];

  for (const item of items) {
    const store = storeByRequestedId.get(item.storeId);
    const storeProducts = products.filter((product) => String(product.storeId) === String(store._id));
    const product = objectIdPattern.test(item.productId)
      ? storeProducts.find((candidate) => String(candidate._id).toLowerCase() === item.productId.toLowerCase())
        ?? storeProducts.find((candidate) => candidate.productKey === item.productId)
      : storeProducts.find((candidate) => candidate.productKey === item.productId);

    if (!product) {
      issues.push({ storeId: store.slug, productId: item.productId, code: "PRODUCT_NOT_IN_STORE", message: "This product is not available in the selected supermarket." });
      continue;
    }
    if (!product.isAvailable) {
      issues.push({ storeId: store.slug, productId: product.productKey, code: "PRODUCT_UNAVAILABLE", message: "This product is currently unavailable." });
      continue;
    }
    if (!Number.isSafeInteger(product.stockQuantity) || product.stockQuantity < item.quantity) {
      issues.push({
        storeId: store.slug,
        productId: product.productKey,
        code: "INSUFFICIENT_STOCK",
        message: "There is not enough stock to fulfill the requested quantity.",
        availableQuantity: Number.isSafeInteger(product.stockQuantity) ? Math.max(0, product.stockQuantity) : 0,
        requestedQuantity: item.quantity,
      });
      continue;
    }
    if (!Number.isSafeInteger(product.priceKobo) || product.priceKobo < 0) {
      throw Object.assign(new Error("A product price is not configured correctly"), { status: 500, code: "INVALID_PRODUCT_PRICE" });
    }
    verifiedItems.push({
      storeId: store.slug,
      storeObjectId: String(store._id),
      storeName: store.name,
      productId: product.productKey,
      productObjectId: String(product._id),
      productName: product.name,
      description: product.description,
      imageUrl: product.imageUrl,
      unitPriceKobo: product.priceKobo,
      quantity: item.quantity,
    });
  }

  return { items: verifiedItems, issues };
}
