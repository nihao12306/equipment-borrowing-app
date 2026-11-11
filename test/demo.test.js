import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("the local demo checks conflicts and releases returned equipment", { timeout: 10000 }, async (t) => {
  const server = spawn(process.execPath, [fileURLToPath(new URL("../server.js", import.meta.url)), "--demo"], {
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"]
  });
  const exited = once(server, "exit");
  t.after(async () => {
    server.kill();
    await exited;
  });
  const origin = await Promise.race([
    once(server.stdout, "data").then(([data]) => data.toString().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]),
    exited.then(() => { throw new Error("演示服务提前退出"); })
  ]);
  assert.ok(origin);

  async function request(path, payload) {
    const response = await fetch(new URL(path, origin), payload && {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return { status: response.status, body: await response.json() };
  }

  const inventory = await request("/api/inventory");
  assert.equal(inventory.status, 200);
  assert.ok(inventory.body.items.some(({ id }) => id === "DEMO_CAMERA"));

  const start = new Date(Date.now() + 60 * 60_000);
  const end = new Date(start.getTime() + 60 * 60_000);
  const borrow = {
    borrower: "演示借用人",
    host: "演示主播",
    location: "拍摄间",
    start: start.toISOString(),
    end: end.toISOString(),
    deviceIds: ["DEMO_CAMERA"]
  };
  const booked = await request("/api/borrow", borrow);
  assert.equal(booked.status, 200, JSON.stringify(booked.body));
  assert.equal((await request("/api/borrow", borrow)).status, 409);

  const openRecords = await request("/api/open-records");
  assert.equal(openRecords.body.records[0].groupId, booked.body.groupId);
  const returned = await request("/api/return", { groupId: booked.body.groupId });
  assert.equal(returned.status, 200);
  assert.equal(returned.body.closed, 1);
  assert.equal((await request("/api/borrow", borrow)).status, 200);
});
