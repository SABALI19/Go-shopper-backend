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
  const auth = getAuth(req);
  if (!auth.userId) return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Sign in is required" } });
  next();
}

export function roleFromClaims(claims) {
  const metadata = claims?.publicMetadata ?? claims?.public_metadata ?? claims?.metadata;
  const role = metadata?.role ?? claims?.role;
  return ["customer", "supermarket", "admin"].includes(role) ? role : "customer";
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
      const role = await getUserRole(auth);
      if (roles.includes(role)) {
        return next();
      }
      return res.status(403).json({ error: { code: "FORBIDDEN", message: "Your account cannot perform this action" } });
    } catch (error) {
      return next(error);
    }
  };
}
