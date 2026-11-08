export function validateCheckoutRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "The request body must be an object containing items" };
  }
  const bodyKeys = Object.keys(body);
  if (bodyKeys.some((key) => key !== "items")) {
    return { error: "Only the items field is accepted; prices and totals are calculated by the server" };
  }
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 100) {
    return { error: "items must contain between 1 and 100 cart lines" };
  }

  const seen = new Set();
  const items = [];
  for (const [index, item] of body.items.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { error: `items[${index}] must be an object` };
    }
    if (Object.keys(item).some((key) => !["productId", "storeId", "quantity"].includes(key))) {
      return { error: `items[${index}] may contain only productId, storeId, and quantity` };
    }
    const { productId, storeId, quantity } = item;
    if (typeof productId !== "string" || !productId.trim() || productId.length > 128 || /\s/.test(productId)) {
      return { error: `items[${index}].productId must be a non-empty identifier` };
    }
    if (typeof storeId !== "string" || !storeId.trim() || storeId.length > 128 || /\s/.test(storeId)) {
      return { error: `items[${index}].storeId must be a non-empty identifier` };
    }
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000) {
      return { error: `items[${index}].quantity must be an integer from 1 to 1000` };
    }
    const key = `${storeId}\u0000${productId}`;
    if (seen.has(key)) return { error: `items[${index}] duplicates a product and store already in the cart` };
    seen.add(key);
    items.push({ productId: productId.trim(), storeId: storeId.trim(), quantity });
  }
  return { items };
}

export function buildCheckoutQuote(items, pricing) {
  const stores = new Map();
  for (const item of items) {
    const subtotalKobo = item.unitPriceKobo * item.quantity;
    if (!Number.isSafeInteger(subtotalKobo)) {
      throw Object.assign(new Error("The cart amount is too large to quote"), { status: 400, code: "INVALID_CART_AMOUNT" });
    }
    const current = stores.get(item.storeId) ?? {
      storeId: item.storeId,
      storeName: item.storeName,
      items: [],
      merchandiseSubtotalKobo: 0,
    };
    current.items.push({
      productId: item.productId,
      productName: item.productName,
      unitPriceKobo: item.unitPriceKobo,
      quantity: item.quantity,
      lineTotalKobo: subtotalKobo,
    });
    current.merchandiseSubtotalKobo += subtotalKobo;
    if (!Number.isSafeInteger(current.merchandiseSubtotalKobo)) {
      throw Object.assign(new Error("The store subtotal is too large to quote"), { status: 400, code: "INVALID_CART_AMOUNT" });
    }
    stores.set(item.storeId, current);
  }

  const storeQuotes = [...stores.values()].map((store) => {
    const amountRemainingKobo = Math.max(0, pricing.minimumStoreSubtotalKobo - store.merchandiseSubtotalKobo);
    return {
      ...store,
      minimumOrderKobo: pricing.minimumStoreSubtotalKobo,
      eligible: amountRemainingKobo === 0,
      amountRemainingKobo,
    };
  });
  const merchandiseSubtotalKobo = storeQuotes.reduce((sum, store) => sum + store.merchandiseSubtotalKobo, 0);
  const deliveryFeeKobo = pricing.deliveryFeeKobo;
  const serviceFeeKobo = pricing.serviceFeeKobo;
  const totalKobo = merchandiseSubtotalKobo + deliveryFeeKobo + serviceFeeKobo;
  if (![merchandiseSubtotalKobo, totalKobo].every(Number.isSafeInteger)) {
    throw Object.assign(new Error("The cart total is too large to quote"), { status: 400, code: "INVALID_CART_AMOUNT" });
  }

  return {
    stores: storeQuotes,
    merchandiseSubtotalKobo,
    deliveryFeeKobo,
    serviceFeeKobo,
    totalKobo,
    eligible: storeQuotes.length > 0 && storeQuotes.every((store) => store.eligible),
  };
}
