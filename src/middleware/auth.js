import { createHmac, timingSafeEqual } from "node:crypto";
import { User } from "../models/User.js";
import { UserSession } from "../models/UserSession.js";

export function signAccessToken(user, sessionId, secret, now = Date.now()) {
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({ sub: String(user._id), sid: String(sessionId), role: user.role, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 900 });
  const input = `${header}.${payload}`;
  return `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
}

export function verifyAccessToken(token, secret, now = Date.now()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const input = `${parts[0]}.${parts[1]}`;
  const expected = createHmac("sha256", secret).update(input).digest();
  let supplied;
  try { supplied = Buffer.from(parts[2], "base64url"); } catch { return null; }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!claims.sub || !claims.sid || !Number.isSafeInteger(claims.exp) || claims.exp <= Math.floor(now / 1000)) return null;
    return claims;
  } catch { return null; }
}

export function configureAuth(app, config) {
  app.locals.authConfig = config;
  app.use(async (req, _res, next) => {
    const token = bearerToken(req.headers.authorization);
    if (!token) { req.auth = null; return next(); }
    const claims = verifyAccessToken(token, config.authAccessTokenSecret);
    if (!claims) { req.auth = null; return next(); }
    try {
      const [user, session] = await Promise.all([
        User.findById(claims.sub).select("role isSuspended approvalStatus email emailVerified phone phoneVerified firstName lastName").lean(),
        UserSession.findOne({ _id: claims.sid, userId: claims.sub, revokedAt: null, expiresAt: { $gt: new Date() } }).select("_id").lean(),
      ]);
      req.auth = user && session ? { userId: String(user._id), sessionId: String(session._id), role: user.role, user } : null;
    } catch (error) { return next(error); }
    return next();
  });
}

export function requireAuth(req, res, next) {
  if (!req.auth?.userId) return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Sign in is required." } });
  if (req.auth.user?.isSuspended) return res.status(403).json({ error: { code: "ACCOUNT_SUSPENDED", message: "This account is suspended. Contact Go-Shopper support." } });
  return next();
}

export function requireRoles(...roles) {
  return async (req, res, next) => {
    if (!req.auth?.userId) return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Sign in is required." } });
    try {
      const user = req.auth.user || await User.findById(req.auth.userId).select("role isSuspended approvalStatus").lean();
      if (!user || user.isSuspended) return res.status(403).json({ error: { code: "ACCOUNT_SUSPENDED", message: "This account cannot access protected features." } });
      if (!roles.includes(user.role)) return res.status(403).json({ error: { code: "FORBIDDEN", message: "Your account cannot perform this action." } });
      if (["supermarket", "rider"].includes(user.role) && user.approvalStatus !== "approved") return res.status(403).json({ error: { code: "APPROVAL_REQUIRED", message: "Your account needs approval before operational access is enabled." } });
      req.auth.user = user;
      return next();
    } catch (error) { return next(error); }
  };
}

export async function getUserRole(auth) {
  if (auth?.role) return auth.role;
  if (!auth?.userId) return null;
  const user = await User.findById(auth.userId).select("role").lean();
  return user?.role || null;
}

export function bearerToken(header) {
  const match = /^Bearer\s+(.+)$/i.exec(String(header || ""));
  return match?.[1] || "";
}

function encode(value) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
