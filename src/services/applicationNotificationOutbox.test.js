import assert from "node:assert/strict";
import { test } from "node:test";
import { enqueueApplicationEmail, startApplicationNotificationWorker } from "./applicationNotificationOutbox.js";

test("application notification enqueue is idempotent and stores only one key", async () => {
  const rows = new Map(); const Model = { async updateOne(filter, update, options) { assert.equal(options.upsert, true); if (!rows.has(filter.idempotencyKey)) rows.set(filter.idempotencyKey, update.$setOnInsert); return { acknowledged: true, upsertedCount: rows.has(filter.idempotencyKey) ? 1 : 0 }; } };
  await enqueueApplicationEmail({ key: "app:admin:new", kind: "new_application", to: "ops@example.com", subject: "New application", text: "Review" }, Model);
  await enqueueApplicationEmail({ key: "app:admin:new", kind: "new_application", to: "ops@example.com", subject: "New application", text: "Review" }, Model);
  assert.equal(rows.size, 1); assert.equal(rows.get("app:admin:new").status, "pending");
});

test("outbox retries provider failure without exposing it and records acceptance on success", async () => {
  const row = { to: "ops@example.com", subject: "New application", text: "Review", html: "<p>Review</p>", attempts: 0, status: "pending", select() { return Promise.resolve(this); }, async save() {} };
  const Model = { findOneAndUpdate() { return { select: async () => { if (row.status === "sent" || row.nextAttemptAt > new Date()) return null; row.status = "sending"; row.attempts += 1; return row; } }; } };
  let deliveries = 0; const stop = startApplicationNotificationWorker({ intervalMs: 30, Model, async deliver() { deliveries += 1; if (deliveries === 1) throw new Error("provider unavailable"); return true; } });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(row.status, "pending"); assert.equal(row.attempts, 1); assert.equal(row.lastError, "provider unavailable"); assert.ok(row.nextAttemptAt > new Date());
  row.nextAttemptAt = new Date(0);
  await new Promise(resolve => setTimeout(resolve, 50));
  stop();
  assert.equal(row.status, "sent"); assert.ok(row.acceptedAt); assert.equal(deliveries, 2);
});
