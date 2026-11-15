function integerKobo(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error(`${name} must be a non-negative integer amount in kobo`);
  }
  return amount;
}

export function getCheckoutPricing(env = process.env) {
  const multiStoreCheckoutMinimumKobo = integerKobo(env.MULTI_STORE_CHECKOUT_MINIMUM_KOBO, 900_000, "MULTI_STORE_CHECKOUT_MINIMUM_KOBO");
  if (multiStoreCheckoutMinimumKobo < 1 || multiStoreCheckoutMinimumKobo > 100_000_000) {
    throw new Error("MULTI_STORE_CHECKOUT_MINIMUM_KOBO must be between 1 and 100000000 kobo");
  }
  return {
    multiStoreCheckoutMinimumKobo,
    deliveryFeeKobo: integerKobo(env.CHECKOUT_DELIVERY_FEE_KOBO, 0, "CHECKOUT_DELIVERY_FEE_KOBO"),
    serviceFeeKobo: integerKobo(env.CHECKOUT_SERVICE_FEE_KOBO, 0, "CHECKOUT_SERVICE_FEE_KOBO"),
  };
}
