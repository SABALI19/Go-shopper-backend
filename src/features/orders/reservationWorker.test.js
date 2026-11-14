import test from "node:test";
import assert from "node:assert/strict";
import { startOrderReservationExpiryWorker } from "./reservationWorker.js";

function manualTimer() {
  let callback;
  let delay;
  let cleared = false;
  return {
    setIntervalFn(fn, interval) {
      callback = fn;
      delay = interval;
      return { unref() {} };
    },
    clearIntervalFn() { cleared = true; },
    tick() { callback(); },
    get delay() { return delay; },
    get cleared() { return cleared; },
  };
}

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("reservation worker runs an initial sweep and schedules later sweeps", async () => {
  const timer = manualTimer();
  let calls = 0;
  const stop = startOrderReservationExpiryWorker({
    intervalSeconds: 10,
    expireReservations: async () => { calls += 1; },
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  });

  await flushAsyncWork();
  assert.equal(calls, 1);
  assert.equal(timer.delay, 10_000);
  timer.tick();
  await flushAsyncWork();
  assert.equal(calls, 2);
  stop();
  assert.equal(timer.cleared, true);
});

test("reservation worker prevents overlapping sweeps", async () => {
  const timer = manualTimer();
  let calls = 0;
  let finishFirst;
  const stop = startOrderReservationExpiryWorker({
    intervalSeconds: 1,
    expireReservations: () => {
      calls += 1;
      return new Promise((resolve) => { finishFirst = resolve; });
    },
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  });

  await flushAsyncWork();
  timer.tick();
  assert.equal(calls, 1);
  finishFirst();
  await flushAsyncWork();
  timer.tick();
  await flushAsyncWork();
  assert.equal(calls, 2);
  stop();
});

test("reservation worker logs failures and applies capped exponential retry delays", async () => {
  const timer = manualTimer();
  let time = 0;
  let calls = 0;
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(message);
  const stop = startOrderReservationExpiryWorker({
    intervalSeconds: 1,
    maxRetryDelaySeconds: 3,
    now: () => time,
    expireReservations: async () => {
      calls += 1;
      if (calls <= 3) throw new Error("database unavailable");
    },
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
  });

  try {
    await flushAsyncWork();
    assert.equal(calls, 1);
    assert.equal(errors.length, 1);
    timer.tick();
    await flushAsyncWork();
    assert.equal(calls, 1, "first retry is delayed by one interval");

    time = 1_000;
    timer.tick();
    await flushAsyncWork();
    assert.equal(calls, 2);
    assert.match(errors[1], /retry scheduled in 2000ms/);

    time = 2_999;
    timer.tick();
    await flushAsyncWork();
    assert.equal(calls, 2, "second retry respects exponential delay");

    time = 3_000;
    timer.tick();
    await flushAsyncWork();
    assert.equal(calls, 3);
    assert.match(errors[2], /retry scheduled in 3000ms/);

    time = 5_999;
    timer.tick();
    await flushAsyncWork();
    assert.equal(calls, 3, "retry delay is capped");

    time = 6_000;
    timer.tick();
    await flushAsyncWork();
    assert.equal(calls, 4, "worker recovers on the next eligible attempt");
  } finally {
    console.error = originalError;
    stop();
  }
});

test("reservation worker rejects invalid retry timing instead of creating a hot loop", () => {
  assert.throws(() => startOrderReservationExpiryWorker({ intervalSeconds: 0 }), /intervalSeconds/);
  assert.throws(() => startOrderReservationExpiryWorker({ intervalSeconds: 5, maxRetryDelaySeconds: 0 }), /maxRetryDelaySeconds/);
});
