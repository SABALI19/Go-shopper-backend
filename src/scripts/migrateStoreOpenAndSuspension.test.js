import assert from "node:assert/strict";
import { test } from "node:test";
import { legacyStoreStateMigrationFilter, legacyStoreStateMigrationPipeline } from "./migrateStoreOpenAndSuspension.js";

test("store state migration only transforms records carrying the legacy state and removes it", () => {
  const pipeline = legacyStoreStateMigrationPipeline();
  assert.deepEqual(pipeline[0].$set.isOpen, { $eq: ["$isActive", true] });
  assert.deepEqual(pipeline[0].$set.isSuspended, { $eq: ["$isActive", false] });
  assert.deepEqual(pipeline[1], { $unset: "isActive" });
  // The migration's update filter is isActive exists, so already-migrated rows are untouched on a rerun.
  assert.deepEqual(legacyStoreStateMigrationFilter(), { isActive: { $exists: true } });
});
