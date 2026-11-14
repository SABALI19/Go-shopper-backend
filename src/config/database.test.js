import test from "node:test";
import assert from "node:assert/strict";
import { connectDatabase } from "./database.js";

test("connectDatabase resolves only after Mongo and required order models initialize", async () => {
  const events = [];
  const mongooseClient = {
    set(key, value) { events.push(["set", key, value]); },
    async connect(uri, options) { events.push(["connect", uri, options.serverSelectionTimeoutMS]); },
  };
  const models = ["ParentOrder", "SubOrder", "Product"].map((name) => ({
    async init() { events.push(["init", name]); },
  }));
  const originalLog = console.log;
  console.log = () => {};

  try {
    await connectDatabase("mongodb://test/GoShopper", { mongooseClient, models });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(events.slice(0, 2), [["set", "strictQuery", true], ["connect", "mongodb://test/GoShopper", 10_000]]);
  assert.deepEqual(new Set(events.filter(([kind]) => kind === "init").map(([, name]) => name)), new Set(["ParentOrder", "SubOrder", "Product"]));
  assert.equal(events.filter(([kind]) => kind === "init").length, 3);
});
