import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import express from "express";
import argon2 from "argon2";
import { verifyAccessToken } from "../middleware/auth.js";
import { createAuthRouter } from "./auth.js";

const secret = "unit-test-only-secret-that-is-long-enough-123";
function query(value) { return { select() { return this; }, sort() { return this; }, lean() { return Promise.resolve(value); }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } }; }
function appWith(router) { const app = express(); app.locals.authConfig = { authAccessTokenSecret: secret, nodeEnv: "test" }; app.use(express.json()); app.use("/api/auth", router); return app; }
async function request(app, path, body) { const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve)); try { const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; } finally { await new Promise(resolve => server.close(resolve)); } }
const sha = value => createHash("sha256").update(value).digest("hex");

test("registration normalizes identity, hashes passwords with Argon2id, and never accepts admin signup", async () => {
  let created; const challenges = []; let verificationEmail = "";
  const UserModel = { findOne: () => query(null), async create(value) { created = { ...value, _id: "user-internal-1" }; return created; } };
  const ChallengeModel = { findOne: () => query(null), updateMany: async () => ({}), async create(row) { challenges.push(row); return row; } };
  const previousWebUrl = process.env.WEB_APP_URL;
  process.env.WEB_APP_URL = "https://web.test";
  const app = appWith(createAuthRouter({ UserModel, ChallengeModel, sendEmail: async ({ text }) => { verificationEmail = text; return true; }, sendSms: async () => true }));
  try {
  assert.equal((await request(app, "/api/auth/register/rider", { role: "customer", email: "role-tamper@example.com" })).status, 400);
  assert.equal(created, undefined);
  assert.equal((await request(app, "/api/auth/register/admin", { email: "admin@example.com" })).status, 400);
  assert.equal((await request(app, "/api/auth/register/customer", { role: "admin", email: "role-tamper@example.com" })).status, 400);
  const response = await request(app, "/api/auth/register/customer", { firstName: " Ada ", lastName: "Lovelace", email: " ADA@Example.COM ", phone: "08012345678", password: "a-secure-password" });
  assert.equal(response.status, 201); assert.equal(created.email, "ada@example.com"); assert.equal(created.phone, "+2348012345678"); assert.equal(created.role, "customer"); assert.notEqual(created.passwordHash, "a-secure-password"); assert.equal(await argon2.verify(created.passwordHash, "a-secure-password"), true); assert.equal(challenges.length, 2); assert.equal("token" in response.body, false);
  const verifyUrl = new URL(verificationEmail.slice(verificationEmail.indexOf("https://")));
  assert.equal(verifyUrl.pathname, "/verify-email"); assert.equal(verifyUrl.searchParams.get("returnTo"), "/welcome/customer");
  } finally {
    if (previousWebUrl === undefined) delete process.env.WEB_APP_URL;
    else process.env.WEB_APP_URL = previousWebUrl;
  }
});

test("role-specific registration endpoints assign fixed roles and return applicants to the matching application", async () => {
  const previousWebUrl = process.env.WEB_APP_URL;
  process.env.WEB_APP_URL = "https://web.test";
  let created;
  const verificationEmails = [];
  const UserModel = { findOne: () => query(null), async create(value) { created = { ...value, _id: `user-${value.role}` }; return created; } };
  const ChallengeModel = { findOne: () => query(null), updateMany: async () => ({}), async create(row) { return row; } };
  const app = appWith(createAuthRouter({ UserModel, ChallengeModel, sendEmail: async ({ text }) => { verificationEmails.push(text); return true; }, sendSms: async () => true }));
  try {
    for (const role of ["customer", "rider", "supermarket"]) {
      const response = await request(app, `/api/auth/register/${role}`, { firstName: "Applicant", lastName: "One", email: `${role}@example.com`, phone: `0801234567${role === "customer" ? "1" : role === "rider" ? "2" : "3"}`, password: "a-secure-password" });
      assert.equal(response.status, 201);
      assert.equal(created.role, role);
      assert.equal(created.approvalStatus, role === "customer" ? "approved" : "pending");
      assert.equal(response.body.user.role, role);
      const link = verificationEmails.at(-1).slice(verificationEmails.at(-1).indexOf("https://"));
      const verifyUrl = new URL(link);
      assert.equal(verifyUrl.searchParams.get("returnTo"), role === "customer" ? "/welcome/customer" : `/register/${role}`);
    }
  } finally {
    if (previousWebUrl === undefined) delete process.env.WEB_APP_URL;
    else process.env.WEB_APP_URL = previousWebUrl;
  }
});

test("registration rejects an email already used by an account of another role", async () => {
  let createCalled = false;
  const UserModel = {
    findOne(filter) { assert.equal(filter.email, "existing@example.com"); return query({ _id: "existing-user", role: "customer" }); },
    async create() { createCalled = true; throw new Error("must not create duplicate"); },
  };
  const app = appWith(createAuthRouter({ UserModel }));
  const response = await request(app, "/api/auth/register/rider", { firstName: "Applicant", lastName: "One", email: " EXISTING@example.com ", phone: "08012345678", password: "a-secure-password" });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, "ACCOUNT_ALREADY_EXISTS");
  assert.equal(createCalled, false);
});

test("email verification consumes the matching challenge and marks only its user verified", async () => {
  const token = "email-verification-token-for-a-test-account";
  const challenge = { userId: "verified-user", purpose: "email_verification", tokenHash: sha(token), consumedAt: null, expiresAt: new Date(Date.now() + 60_000), async save() {} };
  let updated;
  const UserModel = { async updateOne(filter, update) { updated = { filter, update }; return { modifiedCount: 1 }; } };
  const ChallengeModel = { findOne(filter) { return query(filter.tokenHash === challenge.tokenHash ? challenge : null); } };
  const app = appWith(createAuthRouter({ UserModel, ChallengeModel }));
  const response = await request(app, "/api/auth/verify-email", { token });
  assert.equal(response.status, 200);
  assert.equal(response.body.verified, true);
  assert.ok(challenge.consumedAt);
  assert.equal(updated.filter._id, challenge.userId);
  assert.equal(updated.update.$set.emailVerified, true);
});

test("login uses normalized email and only issues a short-lived signed token after both verifications", async () => {
  const passwordHash = await argon2.hash("a-secure-password", { type: argon2.argon2id });
  const account = { _id: "internal-user-id", firstName: "Ada", lastName: "Lovelace", email: "ada@example.com", emailVerified: true, phone: "+2348012345678", phoneVerified: true, role: "customer", approvalStatus: "approved", isSuspended: false, passwordHash, save: async () => account };
  const unverified = { ...account, emailVerified: false };
  let selected = "";
  const UserModel = { findOne(filter) { selected = filter.$or[0].email; return query(selected === "unverified@example.com" ? unverified : account); } };
  const SessionModel = { async create(value) { return { ...value, id: "session-1", save: async () => {} }; } };
  const app = appWith(createAuthRouter({ UserModel, SessionModel }));
  assert.equal((await request(app, "/api/auth/login", { identifier: "UNVERIFIED@example.com", password: "a-secure-password" })).status, 403);
  const response = await request(app, "/api/auth/login", { identifier: " ADA@Example.com ", password: "a-secure-password" });
  assert.equal(response.status, 200); assert.equal(selected, "ada@example.com"); assert.equal(response.body.user.id, account._id); assert.equal(response.body.user.role, "customer"); assert.ok(response.body.refreshToken); const claims = verifyAccessToken(response.body.accessToken, secret); assert.equal(claims.sub, account._id); assert.equal(claims.sid, "session-1"); assert.ok(claims.exp - claims.iat <= 900);
});

test("refresh rotates tokens and reuse revokes the session", async () => {
  const oldToken = "session-rotation-id.original-secret-value";
  const session = { _id: "session-rotation-id", id: "session-rotation-id", userId: "internal-user-id", refreshTokenHash: sha(oldToken), expiresAt: new Date(Date.now() + 60_000), revokedAt: null, save: async () => {} };
  const user = { _id: "internal-user-id", role: "customer", approvalStatus: "approved", isSuspended: false };
  const UserModel = { findById: () => query(user) };
  const SessionModel = {
    findById: () => query(session),
    async updateOne(filter, update) { if (filter.refreshTokenHash !== session.refreshTokenHash || session.revokedAt) return { modifiedCount: 0 }; session.refreshTokenHash = update.$set.refreshTokenHash; return { modifiedCount: 1 }; },
  };
  const app = appWith(createAuthRouter({ UserModel, SessionModel }));
  const first = await request(app, "/api/auth/refresh", { refreshToken: oldToken });
  assert.equal(first.status, 200); assert.notEqual(first.body.refreshToken, oldToken);
  const reuse = await request(app, "/api/auth/refresh", { refreshToken: oldToken });
  assert.equal(reuse.status, 401); assert.ok(session.revokedAt);
});

test("phone verification stores a hash, limits wrong-code attempts, and marks only the matching user verified", async () => {
  const user = { _id: "phone-user", email: "phone@example.com", phone: "+2348012345678", phoneVerified: false, save: async () => {} };
  const challenges = [];
  const UserModel = { findOne: () => query(user) };
  const ChallengeModel = {
    findOne(filter) { const selected = filter.purpose === "phone_verification" && filter.expiresAt ? challenges.findLast(row => row.purpose === "phone_verification") || null : null; return { sort() { return this; }, select() { return Promise.resolve(selected); }, then(resolve, reject) { return Promise.resolve(null).then(resolve, reject); } }; },
    async create(row) { challenges.push({ ...row, save: async () => {} }); },
    updateMany: async () => ({}),
  };
  let deliveredCode = "";
  const app = appWith(createAuthRouter({ UserModel, ChallengeModel, async sendSms(_phone, code) { deliveredCode = code; return true; } }));
  // Trigger the public resend flow, then verify using the delivered OTP.
  const resent = await request(app, "/api/auth/resend-verification", { email: user.email });
  assert.equal(resent.status, 200); assert.equal(challenges.length, 2);
  const phoneChallenge = challenges.find(row => row.purpose === "phone_verification");
  assert.equal(deliveredCode.length, 6); assert.notEqual(phoneChallenge.tokenHash, deliveredCode);
  assert.equal((await request(app, "/api/auth/verify-phone", { email: user.email, code: "000000" })).status, 400);
  assert.equal(phoneChallenge.attempts, 1);
  assert.equal((await request(app, "/api/auth/verify-phone", { email: user.email, code: deliveredCode })).status, 200);
  assert.equal(user.phoneVerified, true); assert.ok(phoneChallenge.consumedAt);
});
