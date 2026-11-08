function integerKobo(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error(`${name} must be a non-negative integer amount in kobo`);
  }
  return amount;
}

export function getCheckoutPricing(env = process.env) {
  return {
    minimumStoreSubtotalKobo: integerKobo(env.MINIMUM_STORE_ORDER_KOBO, 900_000, "MINIMUM_STORE_ORDER_KOBO"),
    deliveryFeeKobo: integerKobo(env.CHECKOUT_DELIVERY_FEE_KOBO, 0, "CHECKOUT_DELIVERY_FEE_KOBO"),
    serviceFeeKobo: integerKobo(env.CHECKOUT_SERVICE_FEE_KOBO, 0, "CHECKOUT_SERVICE_FEE_KOBO"),
  };
}
