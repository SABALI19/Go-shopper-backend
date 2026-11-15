import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { createUsersRouter } from "./users.js";

test("current user's profile includes own last login timestamp", async () => {
  const lastLoginAt = new Date("2026-10-22T09:15:00.000Z");
  const user = { _id: "user-1", firstName: "Ada", lastName: "Lovelace", email: "ada@example.com", phone: "+2348000000000", role: "admin", approvalStatus: "approved", isSuspended: false, lastLoginAt };
  const UserModel = { findById: (id) => ({ lean: async () => id === "user-1" ? user : null }) };
  const authenticate = (req, _res, next) => { req.auth = { userId: "user-1", role: "admin" }; next(); };
  const app = express();
  app.use("/api/users", createUsersRouter({ UserModel, authenticate }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/users/me`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.user.lastLoginAt, lastLoginAt.toISOString());
    assert.equal(body.user.id, "user-1");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
