import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import { OfflineDamageRecovery } from "../js/offline-damage-recovery.js?v=22";

test("reports arriving during an inspection trigger a fresh inspection", async () => {
  let finish;
  const inspection = new Promise((resolve) => { finish = resolve; });
  let calls = 0;
  const recovery = new OfflineDamageRecovery({
    canRun: () => true,
    inspect: () => ++calls === 1 ? inspection : Promise.resolve("applied"),
    sync: assert.fail,
  });
  recovery.report();
  await settle();
  const first = recovery.check;
  recovery.report();
  assert.equal(calls, 1);
  finish("applied");
  await first;
  await recovery.check;
  assert.equal(calls, 2);
  assert.equal(recovery.pending, false);
});

for (const failure of ["exception", "failed", "timed-out", "busy"]) {
  test(`an inspection with ${failure} retries with backoff and stops after success`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(console, "warn", () => {});
    let calls = 0;
    const recovery = new OfflineDamageRecovery({
      canRun: () => true,
      async inspect() {
        calls++;
        if (calls > 2) return "applied";
        if (failure === "exception") throw new Error("Temporary storage failure");
        return failure;
      },
      sync: async () => {},
    });
    recovery.report();
    await recovery.check;
    assert.equal(recovery.pending, true);
    t.mock.timers.tick(2999);
    await settle();
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    await settle();
    await recovery.check;
    assert.equal(calls, 2);
    t.mock.timers.tick(5999);
    await settle();
    assert.equal(calls, 2);
    t.mock.timers.tick(1);
    await settle();
    await recovery.check;
    assert.equal(calls, 3);
    assert.equal(recovery.pending, false);
    t.mock.timers.tick(60_000);
    await settle();
    assert.equal(calls, 3);
    assert.equal(recovery.retryTimer, null);
  });
}

test("repeated inspection failures cap the delay at 30 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const recovery = new OfflineDamageRecovery({
    canRun: () => true,
    inspect: async () => ++calls < 7 ? "timed-out" : "applied",
    sync: assert.fail,
  });
  recovery.report();
  await recovery.check;
  for (const delay of [3000, 6000, 12_000, 24_000, 30_000, 30_000]) {
    t.mock.timers.tick(delay);
    await settle();
    if (recovery.check) await recovery.check;
  }
  assert.equal(calls, 7);
  assert.equal(recovery.pending, false);
  assert.equal(recovery.retryTimer, null);
  assert.equal(recovery.retryDelay, 3000);
});

test("repeated stale inspections back off even when new reports arrive", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const recovery = new OfflineDamageRecovery({
    canRun: () => true,
    inspect: async () => ++calls < 4 ? "stale" : "applied",
    sync: async () => {},
  });
  recovery.report();
  await recovery.check;
  if (recovery.check) await recovery.check;
  assert.equal(calls, 2);
  assert.equal(recovery.pending, true);
  recovery.report();
  recovery.resume();
  t.mock.timers.tick(2999);
  await settle();
  assert.equal(calls, 2);
  t.mock.timers.tick(1);
  await settle();
  if (recovery.check) await recovery.check;
  assert.equal(calls, 3);
  recovery.report();
  t.mock.timers.tick(5999);
  await settle();
  assert.equal(calls, 3);
  t.mock.timers.tick(1);
  await settle();
  if (recovery.check) await recovery.check;
  assert.equal(calls, 4);
  assert.equal(recovery.pending, false);
  assert.equal(recovery.retryDelay, 3000);
  assert.equal(recovery.retryTimer, null);
});

test("stale inspection retries cap the delay at 30 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const recovery = new OfflineDamageRecovery({
    canRun: () => true,
    inspect: async () => ++calls < 8 ? "stale" : "applied",
    sync: async () => {},
  });
  recovery.report();
  await recovery.check;
  if (recovery.check) await recovery.check;
  assert.equal(calls, 2);
  for (const delay of [3000, 6000, 12_000, 24_000, 30_000, 30_000]) {
    t.mock.timers.tick(delay);
    await settle();
    if (recovery.check) await recovery.check;
  }
  assert.equal(calls, 8);
  assert.equal(recovery.pending, false);
  assert.equal(recovery.retryTimer, null);
  assert.equal(recovery.retryDelay, 3000);
});

for (const failure of ["failed", "timed-out", "lock-timeout"]) {
  test(`reports arriving during repeated ${failure} checks do not bypass backoff`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0;
    let recovery;
    recovery = new OfflineDamageRecovery({
      canRun: () => true,
      inspect: async () => {
        if (++calls > 3) return "applied";
        recovery.report();
        return failure;
      },
      sync: async () => {},
    });
    recovery.report();
    await recovery.check;
    if (recovery.check) await recovery.check;
    assert.equal(calls, 2);
    assert.equal(recovery.pending, true);
    t.mock.timers.tick(2999);
    await settle();
    assert.equal(calls, 2);
    t.mock.timers.tick(1);
    await settle();
    if (recovery.check) await recovery.check;
    assert.equal(calls, 3);
    t.mock.timers.tick(5999);
    await settle();
    assert.equal(calls, 3);
    t.mock.timers.tick(1);
    await settle();
    if (recovery.check) await recovery.check;
    assert.equal(calls, 4);
    assert.equal(recovery.pending, false);
    assert.equal(recovery.retryTimer, null);
    assert.equal(recovery.retryDelay, 3000);
  });
}
