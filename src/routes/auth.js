import { Router } from "express";
import argon2 from "argon2";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { User } from "../models/User.js";
import { UserSession } from "../models/UserSession.js";
import { AuthChallenge } from "../models/AuthChallenge.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, signAccessToken } from "../middleware/auth.js";
import { sendAuthEmail, sendPhoneCode } from "../services/authNotifications.js";

export function createAuthRouter({ UserModel = User, SessionModel = UserSession, ChallengeModel = AuthChallenge, sendEmail = sendAuthEmail, sendSms = sendPhoneCode } = {}) {
const router = Router();
const accessTtlMs = 15 * 60 * 1000;
const refreshTtlMs = 30 * 24 * 60 * 60 * 1000;
const challengeTtlMs = 10 * 60 * 1000;
const maxAttempts = 5;

const registrationHandler = asyncHandler(async (req, res) => {
  const role = req.registrationRole;
  if (!(["customer", "supermarket", "rider"].includes(role))) return fail(res, 400, "INVALID_ACCOUNT_TYPE", "Choose a supported account type.");
  const { firstName, lastName = "", email, phone, password } = req.body || {};
  if (Object.hasOwn(req.body || {}, "role")) return fail(res, 400, "ROLE_NOT_ALLOWED", "Account type is determined by the registration route.");
  const cleanEmail = normalizeEmail(email);
  const cleanPhone = normalizePhone(phone);
  if (!cleanEmail || !/^\S+@\S+\.\S+$/.test(cleanEmail) || cleanEmail.length > 254) return fail(res, 400, "INVALID_EMAIL", "Enter a valid email address.");
  if (!cleanPhone) return fail(res, 400, "INVALID_PHONE", "Enter a valid phone number in international format.");
  if (typeof firstName !== "string" || !firstName.trim() || firstName.trim().length > 60 || typeof lastName !== "string" || lastName.trim().length > 60) return fail(res, 400, "INVALID_NAME", "Enter a valid first and last name.");
  if (typeof password !== "string" || password.length < 10 || password.length > 128) return fail(res, 400, "INVALID_PASSWORD", "Password must be between 10 and 128 characters.");
  if (await UserModel.findOne({ email: cleanEmail }).select("_id")) return fail(res, 409, "ACCOUNT_ALREADY_EXISTS", "An account already uses that email address.");
  let user;
  try {
    user = await UserModel.create({ email: cleanEmail, phone: cleanPhone, passwordHash: await argon2.hash(password, { type: argon2.argon2id }), firstName: firstName.trim(), lastName: lastName.trim(), role, approvalStatus: role === "customer" ? "approved" : "pending", ...(role === "rider" ? { riderProfile: { approvalStatus: "pending", isOnline: false } } : {}) });
  } catch (error) {
    if (error?.code === 11000) return fail(res, 409, "ACCOUNT_ALREADY_EXISTS", "An account already uses that email address.");
    throw error;
  }
  const emailSent = await issueChallenge(user, "email_verification").catch(() => false);
  const phoneCodeSent = await issueChallenge(user, "phone_verification").catch(() => false);
  return res.status(201).json({ user: publicUser(user), verification: { emailSent, phoneCodeSent, emailRequired: true, phoneRequired: true } });
});
for (const role of ["customer", "supermarket", "rider"]) {
  router.post(`/register/${role}`, authRateLimit("register"), (req, _res, next) => { req.registrationRole = role; next(); }, registrationHandler);
}
router.post("/register/:role", authRateLimit("register"), (req, res) => fail(res, 400, "INVALID_ACCOUNT_TYPE", "Choose a supported account type."));

router.post("/login", authRateLimit("login"), asyncHandler(async (req, res) => {
  const identifier = String(req.body?.identifier ?? req.body?.email ?? req.body?.phone ?? "").trim();
  const email = normalizeEmail(identifier);
  const phone = normalizePhone(identifier);
  const user = await UserModel.findOne({ $or: [{ email }, ...(phone ? [{ phone, phoneVerified: true }] : [])] }).select("+passwordHash");
  if (!user || !await argon2.verify(user.passwordHash, String(req.body?.password || ""))) return fail(res, 401, "INVALID_CREDENTIALS", "Email/phone or password is incorrect.");
  if (!user.emailVerified || !user.phoneVerified) return res.status(403).json({ error: { code: "VERIFICATION_REQUIRED", message: "Verify your email address and phone number before signing in.", emailVerified: user.emailVerified, phoneVerified: user.phoneVerified } });
  if (user.isSuspended) return fail(res, 403, "ACCOUNT_SUSPENDED", "This account is suspended. Contact Go-Shopper support.");
  user.lastLoginAt = new Date();
  await user.save();
  return issueSession(req, res, user);
}));

router.post("/verify-email", authRateLimit("verify-email"), asyncHandler(async (req, res) => {
  const token = String(req.body?.token || "");
  if (token.length < 32 || token.length > 256) return fail(res, 400, "INVALID_VERIFICATION", "Verification link is invalid or expired.");
  const challenge = await ChallengeModel.findOne({ purpose: "email_verification", tokenHash: hash(token), consumedAt: null, expiresAt: { $gt: new Date() } });
  if (!challenge) return fail(res, 400, "INVALID_VERIFICATION", "Verification link is invalid or expired.");
  challenge.consumedAt = new Date(); await challenge.save();
  await UserModel.updateOne({ _id: challenge.userId }, { $set: { emailVerified: true } });
  return res.json({ verified: true });
}));

router.post("/verify-phone", authRateLimit("verify-phone"), asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const phone = normalizePhone(req.body?.phone);
  if (!email && !phone) return fail(res, 400, "INVALID_VERIFICATION", "Verification code is invalid or expired.");
  const user = await UserModel.findOne({ $or: [...(email ? [{ email }] : []), ...(phone ? [{ phone }] : [])] });
  if (!user) return fail(res, 400, "INVALID_VERIFICATION", "Verification code is invalid or expired.");
  const challenge = await ChallengeModel.findOne({ userId: user._id, purpose: "phone_verification", consumedAt: null, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).select("+tokenHash");
  if (!challenge || challenge.attempts >= maxAttempts) return fail(res, 400, "INVALID_VERIFICATION", "Verification code is invalid or expired.");
  const supplied = hash(String(req.body?.code || ""));
  challenge.attempts += 1;
  if (!safeEqual(challenge.tokenHash, supplied)) { await challenge.save(); return fail(res, 400, "INVALID_VERIFICATION", "Verification code is invalid or expired."); }
  challenge.consumedAt = new Date(); await challenge.save();
  try { user.phoneVerified = true; await user.save(); }
  catch (error) { if (error?.code === 11000) return fail(res, 409, "PHONE_ALREADY_VERIFIED", "That verified phone number is already linked to an account."); throw error; }
  return res.json({ verified: true });
}));

router.post("/resend-verification", authRateLimit("resend"), asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const user = await UserModel.findOne({ email });
  // Avoid revealing whether an email has an account.
  if (user) {
    if (!user.emailVerified) await issueChallenge(user, "email_verification").catch(() => false);
    if (!user.phoneVerified) await issueChallenge(user, "phone_verification").catch(() => false);
  }
  return res.json({ message: "If the account needs verification, a new code has been sent." });
}));

router.post("/password/forgot", authRateLimit("forgot"), asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const user = await UserModel.findOne({ email });
  if (user) await issueChallenge(user, "password_reset").catch(() => false);
  return res.json({ message: "If an account exists for that email, password reset instructions will be sent." });
}));

router.post("/password/reset", authRateLimit("reset"), asyncHandler(async (req, res) => {
  const token = String(req.body?.token || "");
  const password = req.body?.password;
  if (typeof password !== "string" || password.length < 10 || password.length > 128) return fail(res, 400, "INVALID_PASSWORD", "Password must be between 10 and 128 characters.");
  const challenge = await ChallengeModel.findOne({ purpose: "password_reset", tokenHash: hash(token), consumedAt: null, expiresAt: { $gt: new Date() } });
  if (!challenge) return fail(res, 400, "INVALID_RESET", "Reset link is invalid or expired.");
  challenge.consumedAt = new Date(); await challenge.save();
  const user = await UserModel.findByIdAndUpdate(challenge.userId, { $set: { passwordHash: await argon2.hash(password, { type: argon2.argon2id }) } }, { new: true });
  await SessionModel.updateMany({ userId: challenge.userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
  return res.json({ message: "Password updated. Sign in again.", email: user?.email });
}));

router.post("/refresh", authRateLimit("refresh"), asyncHandler(async (req, res) => {
  const web = isWebClient(req);
  const raw = web ? parseCookies(req.headers.cookie).gs_refresh : String(req.body?.refreshToken || "");
  if (!raw) return fail(res, 401, "SESSION_EXPIRED", "Sign in again to continue.");
  if (web && !csrfValid(req)) return fail(res, 403, "CSRF_INVALID", "Refresh request could not be verified.");
  const [sessionId, secret, ...rest] = raw.split(".");
  if (!sessionId || !secret || rest.length) return fail(res, 401, "SESSION_EXPIRED", "Sign in again to continue.");
  const session = await SessionModel.findById(sessionId).select("+refreshTokenHash");
  if (!session || session.revokedAt || session.expiresAt <= new Date()) return fail(res, 401, "SESSION_EXPIRED", "Sign in again to continue.");
  if (!safeEqual(session.refreshTokenHash, hash(raw))) {
    session.revokedAt = new Date(); await session.save();
    return fail(res, 401, "SESSION_REVOKED", "This session is no longer valid. Sign in again.");
  }
  const user = await UserModel.findById(session.userId);
  if (!user || user.isSuspended) { session.revokedAt = new Date(); await session.save(); return fail(res, 401, "SESSION_REVOKED", "This session is no longer valid. Sign in again."); }
  const nextSecret = randomBytes(48).toString("base64url");
  const nextRaw = `${session.id}.${nextSecret}`;
  const swapped = await SessionModel.updateOne({ _id: session._id, refreshTokenHash: session.refreshTokenHash, revokedAt: null }, { $set: { refreshTokenHash: hash(nextRaw), lastUsedAt: new Date() } });
  if (!swapped.modifiedCount) return fail(res, 401, "SESSION_REVOKED", "This session has already been refreshed. Sign in again.");
  return sendTokens(req, res, user, session.id, nextRaw);
}));

router.post("/logout", requireAuth, asyncHandler(async (req, res) => {
  await SessionModel.updateOne({ _id: req.auth.sessionId, userId: req.auth.userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
  clearCookies(res, req);
  return res.json({ signedOut: true });
}));

router.post("/logout-all", requireAuth, asyncHandler(async (req, res) => {
  await SessionModel.updateMany({ userId: req.auth.userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
  clearCookies(res, req);
  return res.json({ signedOut: true });
}));

router.get("/me", requireAuth, asyncHandler(async (req, res) => res.json({ user: publicUser(req.auth.user) })));
router.patch("/me", requireAuth, asyncHandler(async (req, res) => {
  const allowed = ["firstName", "lastName"];
  if (Object.keys(req.body || {}).some((key) => !allowed.includes(key))) return fail(res, 400, "INVALID_PROFILE", "Only firstName and lastName can be updated here.");
  const update = Object.fromEntries(allowed.filter((key) => typeof req.body?.[key] === "string").map((key) => [key, req.body[key].trim()]));
  if (!update.firstName || update.firstName.length > 60 || (update.lastName && update.lastName.length > 60)) return fail(res, 400, "INVALID_PROFILE", "Enter a valid name.");
  const user = await UserModel.findByIdAndUpdate(req.auth.userId, { $set: update }, { new: true });
  return res.json({ user: publicUser(user) });
}));

async function issueChallenge(user, purpose) {
  const now = new Date();
  const recent = await ChallengeModel.findOne({ userId: user._id, purpose, createdAt: { $gt: new Date(Date.now() - 60_000) } }).sort({ createdAt: -1 });
  if (recent) return false;
  const value = purpose === "phone_verification" ? String(randomInt(0, 1_000_000)).padStart(6, "0") : randomBytes(32).toString("base64url");
  await ChallengeModel.updateMany({ userId: user._id, purpose, consumedAt: null }, { $set: { consumedAt: now } });
  await ChallengeModel.create({ userId: user._id, purpose, tokenHash: hash(value), expiresAt: new Date(Date.now() + challengeTtlMs), attempts: 0, lastSentAt: now });
  if (purpose === "phone_verification") return sendSms(user.phone, value);
  const webUrl = String(process.env.WEB_APP_URL || "").replace(/\/$/, "");
  const verificationDestinations = { customer: "/welcome/customer", supermarket: "/register/supermarket", rider: "/register/rider" };
  const returnTo = purpose === "email_verification" ? verificationDestinations[user.role] : undefined;
  const continuation = returnTo ? `&returnTo=${encodeURIComponent(returnTo)}` : "";
  const href = purpose === "email_verification" ? `${webUrl}/verify-email?token=${encodeURIComponent(value)}${continuation}` : `${webUrl}/reset-password?token=${encodeURIComponent(value)}`;
  const name = escapeHtml(user.firstName);
  const subject = purpose === "email_verification" ? "Verify your Go-Shopper email" : "Reset your Go-Shopper password";
  return sendEmail({ to: user.email, subject, text: `${purpose === "email_verification" ? "Verify your email" : "Reset your password"}: ${href}`, html: `<p>Hello ${name},</p><p><a href="${escapeHtml(href)}">${purpose === "email_verification" ? "Verify your email address" : "Reset your password"}</a></p><p>This link expires in 10 minutes. If you did not request this, ignore this email.</p>` });
}

async function issueSession(req, res, user) {
  const session = await SessionModel.create({ userId: user._id, refreshTokenHash: hash("pending"), expiresAt: new Date(Date.now() + refreshTtlMs), userAgent: String(req.headers["user-agent"] || "").slice(0, 300), ipAddress: String(req.ip || "").slice(0, 64) });
  const raw = `${session.id}.${randomBytes(48).toString("base64url")}`;
  session.refreshTokenHash = hash(raw); await session.save();
  return sendTokens(req, res, user, session.id, raw);
}

function sendTokens(req, res, user, sessionId, refreshToken) {
  const accessToken = signAccessToken(user, sessionId, req.app.locals.authConfig.authAccessTokenSecret);
  if (isWebClient(req)) setCookies(res, req, refreshToken);
  return res.json({ accessToken, ...(isWebClient(req) ? {} : { refreshToken }), expiresIn: Math.floor(accessTtlMs / 1000), user: publicUser(user) });
}

function setCookies(res, req, refreshToken) {
  const secure = req.app.locals.authConfig.nodeEnv === "production";
  const sameSite = secure ? "None" : "Strict";
  const common = `Path=/api/auth; HttpOnly; SameSite=${sameSite}; Max-Age=${Math.floor(refreshTtlMs / 1000)}${secure ? "; Secure" : ""}`;
  res.append("Set-Cookie", `gs_refresh=${encodeURIComponent(refreshToken)}; ${common}`);
  const csrf = randomBytes(24).toString("base64url");
  res.append("Set-Cookie", `gs_csrf=${encodeURIComponent(csrf)}; Path=/; SameSite=${sameSite}; Max-Age=${Math.floor(refreshTtlMs / 1000)}${secure ? "; Secure" : ""}`);
}
function clearCookies(res, req) {
  const secure = req.app.locals.authConfig.nodeEnv === "production";
  const sameSite = secure ? "None" : "Strict";
  res.append("Set-Cookie", `gs_refresh=; Path=/api/auth; HttpOnly; SameSite=${sameSite}; Max-Age=0${secure ? "; Secure" : ""}`);
  res.append("Set-Cookie", `gs_csrf=; Path=/; SameSite=${sameSite}; Max-Age=0${secure ? "; Secure" : ""}`);
}
function csrfValid(req) {
  const cookies = parseCookies(req.headers.cookie);
  const allowedOrigins = req.app.locals.authConfig.corsOrigins || [];
  const origin = String(req.headers.origin || "");
  try { return Boolean(allowedOrigins.includes(origin) && cookies.gs_csrf && req.headers["x-csrf-token"] && safeEqual(cookies.gs_csrf, decodeURIComponent(String(req.headers["x-csrf-token"])))); }
  catch { return false; }
}
function parseCookies(value = "") {
  return Object.fromEntries(String(value).split(";").map((part) => part.trim().split(/=(.*)/s).slice(0, 2)).filter((part) => part.length === 2).flatMap(([key, val]) => {
    try { return [[key, decodeURIComponent(val)]]; } catch { return []; }
  }));
}
function isWebClient(req) { return Boolean(req.headers.origin); }
function publicUser(user) { return { id: String(user._id), firstName: user.firstName, lastName: user.lastName, email: user.email, emailVerified: Boolean(user.emailVerified), phone: user.phone, phoneVerified: Boolean(user.phoneVerified), role: user.role, approvalStatus: user.approvalStatus, isSuspended: Boolean(user.isSuspended) }; }
function normalizeEmail(value) { return typeof value === "string" ? value.trim().normalize("NFKC").toLowerCase() : ""; }
function normalizePhone(value) {
  if (typeof value !== "string") return "";
  const raw = value.trim().replace(/[\s().-]/g, "");
  const e164 = raw.startsWith("+") ? raw : raw.startsWith("0") ? `+234${raw.slice(1)}` : `+${raw}`;
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : "";
}
function hash(value) { return createHash("sha256").update(String(value)).digest("hex"); }
function safeEqual(a, b) { const left = Buffer.from(String(a)); const right = Buffer.from(String(b)); return left.length === right.length && timingSafeEqual(left, right); }
function fail(res, status, code, message) { return res.status(status).json({ error: { code, message } }); }
function escapeHtml(value) { return String(value || "").replace(/[&<>\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]); }

const attempts = new Map();
function authRateLimit(scope) {
  return (req, res, next) => {
    const key = `${scope}:${req.ip || "unknown"}:${normalizeEmail(req.body?.email || req.body?.identifier || "")}`;
    const now = Date.now();
    for (const [entry, value] of attempts) if (value.resetAt <= now) attempts.delete(entry);
    const current = attempts.get(key);
    if (!current || current.resetAt <= now) attempts.set(key, { count: 1, resetAt: now + 15 * 60_000 });
    else if (++current.count > 15) return fail(res, 429, "RATE_LIMITED", "Too many attempts. Try again later.");
    next();
  };
}

return router;
}

export const authRouter = createAuthRouter();
