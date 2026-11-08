import { Router } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";
import { getCheckoutPricing } from "../config/checkoutPricing.js";
import { buildCheckoutQuote, validateCheckoutRequest } from "../features/checkout/pricing.js";
import { resolveCartItems } from "../features/checkout/resolveCart.js";
import { Product } from "../models/Product.js";
import { Store } from "../models/Store.js";

export function createCheckoutRouter({
  StoreModel = Store,
  ProductModel = Product,
  authenticate = requireAuth,
  authorizeCustomer = requireRoles("customer"),
  pricingProvider = getCheckoutPricing,
} = {}) {
  const router = Router();

  router.post("/quote", authenticate, authorizeCustomer, asyncHandler(async (req, res) => {
    const validation = validateCheckoutRequest(req.body);
    if (validation.error) {
      return res.status(400).json({ error: { code: "INVALID_CHECKOUT_REQUEST", message: validation.error } });
    }
    const resolution = await resolveCartItems({
      items: validation.items,
      StoreModel,
      ProductModel,
    });
    if (resolution.issues.length) {
      const issues = resolution.issues;
      return res.status(409).json({ error: { code: "CART_VALIDATION_FAILED", message: "One or more cart items cannot be fulfilled." }, issues });
    }

    const quote = buildCheckoutQuote(resolution.items, await pricingProvider());
    return res.json({ quote });
  }));

  return router;
}

