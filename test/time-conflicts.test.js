import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../server.js", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "")
  .replace('const __dirname = path.dirname(fileURLToPath(import.meta.url));', 'const __dirname = ".";')
  .split("const server = http.createServer")[0];

function app(rows = [], records = []) {
  const context = vm.createContext({
    process: { env: {}, argv: [] },
    path: { join: (...parts) => parts.join("/") }
  });
  vm.runInContext(source, context);
  context.testRows = rows;
  context.testRecords = records;
  vm.runInContext(`
    getSheets = async () => [{ title: '26-9-24', sheet_id: 'daily' }];
    readRange = async () => testRows;
    readRecords = async () => testRecords;
    readInventory = async () => [{ id: 'MIC_DJI_01', name: '大疆领夹麦-灰色', status: '可用' }];
  `, context);
  return context;
}

test("manual time formats include Chinese punctuation, full-width digits and spaces", () => {
  const context = app();
  for (const value of ["16：00-18：00", "１６：００－１８：００", "16: 00 - 18: 00", "16:00～18:00", "16:00至18:00"]) {
    const result = context.parseDailyTimeRange(value, 46289);
    assert.equal(result?.start, "2026-09-24T16:00", value);
    assert.equal(result?.end, "2026-09-24T18:00", value);
  }
});

test("invalid and ambiguous times fail instead of rolling into another date", () => {
  const context = app();
  for (const value of ["25:00-26:00", "16:70-18:00", "16:00-16:00", "待定", "16:00-18:00或19:00-20:00"]) {
    assert.equal(context.parseDailyTimeRange(value, "2026/9/24"), null);
  }
  assert.equal(context.parseDailyTimeRange("23:00-01:00", "2026/9/24").end, "2026-09-25T01:00");
});

test("the reported manual row blocks a overlapping room booking without system records", async () => {
  const context = app([[46289, "16：00-18：00", "王老师", "拍摄间", "麦克风、提词器、线"]]);
  const result = await context.availabilityDetails("2026-09-24T15:00", "2026-09-24T17:00");
  assert.equal(result.locations[0].available, false);
  assert.equal(result.locations[0].blocking.borrower, "王老师");
  const adjacent = await context.availabilityDetails("2026-09-24T18:00", "2026-09-24T19:00");
  assert.equal(adjacent.locations[0].available, true);
});

test("unreadable occupied row identifies its location and blocks checking", async () => {
  const context = app([[46289, "下午", "王老师", "拍摄间"]]);
  await assert.rejects(context.availabilityDetails("2026-09-24T15:00", "2026-09-24T17:00"), (error) => {
    assert.equal(error.status, 409);
    assert.match(error.message, /26-9-24.*第 2 行/);
    return true;
  });
});

test("blank and cancelled rows do not block bookings", async () => {
  const context = app([[null, null, null], [46289, "下午", "王老师", "拍摄间", "", "【已取消】"]]);
  const result = await context.availabilityDetails("2026-09-24T15:00", "2026-09-24T17:00");
  assert.equal(result.locations[0].available, true);
});
