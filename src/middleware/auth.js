import { clerkMiddleware, createClerkClient, getAuth } from "@clerk/express";

export function configureClerk(app, config) {
  app.locals.clerkClient = createClerkClient({
    secretKey: config.clerkSecretKey,
    ...(config.clerkPublishableKey ? { publishableKey: config.clerkPublishableKey } : {}),
  });
  app.use(clerkMiddleware({
    secretKey: config.clerkSecretKey,
    ...(config.clerkPublishableKey ? { publishableKey: config.clerkPublishableKey } : {}),
  }));
}

export function requireAuth(req, res, next) {
  void (async () => {
    const auth = req.auth || getAuth(req);
    if (!auth.userId) return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Sign in is required" } });
    const { User } = await import("../models/User.js");
    const account = await User.findOne({ clerkUserId: auth.userId }).select("isSuspended").lean();
    if (account?.isSuspended) return res.status(403).json({ error: { code: "ACCOUNT_SUSPENDED", message: "This account is suspended. Contact Go-Shopper support." } });
    return next();
  })().catch(next);
}

export function roleFromClaims(claims) {
  const metadata = claims?.publicMetadata ?? claims?.public_metadata ?? claims?.metadata;
  const role = metadata?.role ?? claims?.role;
  return ["customer", "supermarket", "rider", "admin"].includes(role) ? role : "customer";
}

export async function getUserRole(auth) {
  const { User } = await import("../models/User.js");
  const savedUser = await User.findOne({ clerkUserId: auth.userId }).select("role").lean();
  return savedUser?.role || roleFromClaims(auth.sessionClaims);
}

export function requireRoles(...roles) {
  return async (req, res, next) => {
    const auth = req.auth || getAuth(req);
    if (!auth.userId) return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Sign in is required" } });
    try {
      const { User } = await import("../models/User.js");
      const savedUser = await User.findOne({ clerkUserId: auth.userId }).select("role isSuspended").lean();
      if (savedUser?.isSuspended) return res.status(403).json({ error: { code: "ACCOUNT_SUSPENDED", message: "This account is suspended. Contact Go-Shopper support." } });
      const role = savedUser?.role || roleFromClaims(auth.sessionClaims);
      if (roles.includes(role)) {
        return next();
      }
      return res.status(403).json({ error: { code: "FORBIDDEN", message: "Your account cannot perform this action" } });
    } catch (error) {
      return next(error);
    }
  };
}
