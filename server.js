import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDemoSheets } from "./demo-sheets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, ".env");
const PORT = Number(process.env.PORT || 8787);
const demoMode = process.argv.includes("--demo");

const RECORD_HEADERS = [
  "记录ID",
  "关联借用ID",
  "状态",
  "登记来源",
  "借用人",
  "联系方式/飞书名",
  "拍摄主播",
  "拍摄场地",
  "设备ID",
  "设备名称",
  "预约开始时间",
  "预计归还时间",
  "实际归还时间",
  "归还方式",
  "管理员确认人",
  "是否需管理员确认",
  "管理员确认状态",
  "创建时间",
  "更新时间",
  "备注"
];

const DAILY_HEADERS = ["日期", "时间段", "拍摄主播", "拍摄场地", "调用设备", "备注"];
const UNIQUE_LOCATIONS = ["拍摄间"];
const demoSheets = demoMode ? createDemoSheets(RECORD_HEADERS) : null;

let cachedConfig;
let tokenCache = { token: "", expiresAt: 0 };
let borrowQueue = Promise.resolve();

async function loadConfig() {
  if (demoSheets) return demoSheets.config;
  if (cachedConfig) return cachedConfig;
  const values = { ...process.env };
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^([^=#]+)=(.*)$/);
      if (match && !values[match[1].trim()]) values[match[1].trim()] = match[2].trim();
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const required = [
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_SPREADSHEET_TOKEN",
    "FEISHU_INVENTORY_SHEET_ID",
    "FEISHU_RECORDS_SHEET_ID"
  ];
  for (const key of required) {
    if (!values[key]) throw new Error(`Missing config: ${key}`);
  }
  cachedConfig = values;
  return values;
}

async function feishu(pathname, options = {}) {
  const config = await loadConfig();
  const token = await tenantToken(config);
  const response = await fetch(`https://open.feishu.cn/open-apis${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code !== 0) {
    throw new Error(data.msg || `Feishu request failed: ${response.status}`);
  }
  return data;
}

async function tenantToken(config) {
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt - now > 30 * 60 * 1000) return tokenCache.token;
  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      app_id: config.FEISHU_APP_ID,
      app_secret: config.FEISHU_APP_SECRET
    })
  });
  const data = await response.json();
  if (data.code !== 0) throw new Error(data.msg || "Failed to get tenant_access_token");
  tokenCache = {
    token: data.tenant_access_token,
    expiresAt: now + Math.max(60, data.expire - 60) * 1000
  };
  return tokenCache.token;
}

async function readRange(sheetId, range) {
  if (demoSheets) return demoSheets.readRange(sheetId, range);
  const config = await loadConfig();
  const spreadsheet = config.FEISHU_SPREADSHEET_TOKEN;
  const data = await feishu(`/sheets/v2/spreadsheets/${spreadsheet}/values/${sheetId}!${range}`, { method: "GET" });
  return data.data?.valueRange?.values || [];
}

async function writeRange(sheetId, range, values) {
  if (demoSheets) return demoSheets.writeRange(sheetId, range, values);
  const config = await loadConfig();
  const spreadsheet = config.FEISHU_SPREADSHEET_TOKEN;
  return feishu(`/sheets/v2/spreadsheets/${spreadsheet}/values`, {
    method: "PUT",
    body: JSON.stringify({
      valueRange: {
        range: `${sheetId}!${range}`,
        values
      }
    })
  });
}

async function getSheets() {
  if (demoSheets) return demoSheets.getSheets();
  const config = await loadConfig();
  const data = await feishu(`/sheets/v3/spreadsheets/${config.FEISHU_SPREADSHEET_TOKEN}/sheets/query`, { method: "GET" });
  return data.data?.sheets || [];
}

async function addSheet(title, index = 1) {
  if (demoSheets) return demoSheets.addSheet(title, index);
  const config = await loadConfig();
  const data = await feishu(`/sheets/v2/spreadsheets/${config.FEISHU_SPREADSHEET_TOKEN}/sheets_batch_update`, {
    method: "POST",
    body: JSON.stringify({
      requests: [
        {
          addSheet: {
            properties: { title, index }
          }
        }
      ]
    })
  });
  return data.data?.replies?.[0]?.addSheet?.properties;
}

async function ensureDailySheet(date) {
  const title = dailyTitle(date);
  const sheets = await getSheets();
  const existing = sheets.find((sheet) => sheet.title === title);
  if (existing) return existing.sheet_id;
  const config = await loadConfig();
  const systemSheetIds = new Set([
    config.FEISHU_INVENTORY_SHEET_ID,
    config.FEISHU_RECORDS_SHEET_ID
  ]);
  const lastSystemIndex = sheets.reduce((lastIndex, sheet, arrayIndex) => {
    if (!systemSheetIds.has(sheet.sheet_id)) return lastIndex;
    const sheetIndex = Number.isInteger(sheet.index) ? sheet.index : arrayIndex;
    return Math.max(lastIndex, sheetIndex);
  }, -1);
  const created = await addSheet(title, lastSystemIndex >= 0 ? lastSystemIndex + 1 : 1);
  await writeRange(created.sheetId, "A1:F1", [DAILY_HEADERS]);
  return created.sheetId;
}

async function appendRow(sheetId, values) {
  const existing = await readRange(sheetId, "A1:T5000");
  const nextRow = lastUsedRow(existing) + 1;
  const endColumn = columnName(values.length);
  await writeRange(sheetId, `A${nextRow}:${endColumn}${nextRow}`, [values]);
  return nextRow;
}

async function appendRows(sheetId, rows) {
  if (!rows.length) return 0;
  const existing = await readRange(sheetId, "A1:T5000");
  const nextRow = lastUsedRow(existing) + 1;
  const endRow = nextRow + rows.length - 1;
  const endColumn = columnName(rows[0].length);
  await writeRange(sheetId, `A${nextRow}:${endColumn}${endRow}`, rows);
  return nextRow;
}

async function readInventory() {
  const config = await loadConfig();
  const rows = await readRange(config.FEISHU_INVENTORY_SHEET_ID, "A1:H200");
  return rows.slice(1).filter((row) => row[0]).map((row) => ({
    id: row[0],
    category: row[1],
    name: row[2],
    status: row[3],
    directlyBorrowable: row[4] === "是",
    requiresAdmin: row[5] === "是",
    quantity: row[6],
    note: row[7] || ""
  })).filter((item) => item.status !== "不存在");
}

async function readRecords() {
  const config = await loadConfig();
  const rows = await readRange(config.FEISHU_RECORDS_SHEET_ID, "A1:T5000");
  const records = [];
  for (let index = 1; index < rows.length; index++) {
    if (rows[index]?.[0]) records.push(recordFromRow(rows[index], index + 1));
  }
  return records;
}

function recordFromRow(row, rowNumber) {
  const record = { rowNumber };
  RECORD_HEADERS.forEach((header, index) => {
    record[header] = row[index] || "";
  });
  return record;
}

function activeStatuses() {
  return new Set(["预约中", "借用中", "待确认"]);
}

function overlaps(startA, endA, startB, endB) {
  const aStart = new Date(startA).getTime();
  const aEnd = new Date(endA).getTime();
  const bStart = new Date(startB).getTime();
  const bEnd = new Date(endB).getTime();
  return aStart < bEnd && bStart < aEnd;
}

async function availabilityDetails(start, end) {
  const inventory = await readInventory();
  if (!start || !end) {
    const items = inventory.map((item) => {
      const disabledByInventory = item.status === "停用" || item.status === "不存在";
      return {
        ...item,
        available: !disabledByInventory,
        blocking: null,
        reason: disabledByInventory ? item.status : ""
      };
    });
    return {
      items,
      locations: UNIQUE_LOCATIONS.map((name) => ({ name, available: true, blocking: null }))
    };
  }
  const systemRecords = await readRecords();
  const manual = await readDailyManualBlocks(start, end, inventory, systemRecords);
  const records = [
    ...systemRecords,
    ...manual.deviceBlocks
  ];
  const active = activeStatuses();
  const items = inventory.map((item) => {
    const blocking = records.find((record) => (
      record["设备ID"] === item.id &&
      active.has(record["状态"]) &&
      overlaps(start, end, record["预约开始时间"], record["预计归还时间"])
    ));
    const disabledByInventory = item.status === "停用" || item.status === "不存在";
    return {
      ...item,
      available: !blocking && !disabledByInventory,
      blocking: blocking ? {
        borrower: blocking["借用人"],
        start: blocking["预约开始时间"],
        end: blocking["预计归还时间"],
        status: blocking["状态"]
      } : null,
      reason: blocking ? `已被 ${blocking["借用人"] || "他人"} 占用` : disabledByInventory ? item.status : ""
    };
  });
  const locationRecords = [...systemRecords, ...manual.locationBlocks];
  const locations = UNIQUE_LOCATIONS.map((name) => {
    const blocking = locationRecords.find((record) => (
      record["拍摄场地"] === name &&
      active.has(record["状态"]) &&
      overlaps(start, end, record["预约开始时间"], record["预计归还时间"])
    ));
    return {
      name,
      available: !blocking,
      blocking: blocking ? {
        borrower: blocking["借用人"],
        start: blocking["预约开始时间"],
        end: blocking["预计归还时间"],
        status: blocking["状态"]
      } : null,
      reason: blocking ? `该时段已被 ${blocking["借用人"] || "他人"} 预约` : ""
    };
  });
  return { items, locations };
}

async function availability(start, end) {
  return (await availabilityDetails(start, end)).items;
}

async function readDailyManualBlocks(start, end, inventory, systemRecords = []) {
  const sheets = await getSheets();
  const wantedTitles = new Set(dateTitlesBetween(start, end));
  const dateSheets = sheets.filter((sheet) => wantedTitles.has(sheet.title));
  const blocks = [];
  const locationBlocks = [];
  for (const sheet of dateSheets) {
    const rows = await readRange(sheet.sheet_id, "A2:F300");
    for (const [index, row] of rows.entries()) {
      if (isClosedDailyRow(row)) continue;
      const timeRange = parseDailyTimeRange(row[1], row[0] || sheet.title);
      if (!timeRange) {
        if (row.some((cell) => String(cell ?? "").trim())) {
          throw new HttpError(409, `日期页「${sheet.title}」第 ${index + 2} 行的日期或时间无法识别，请先修正为如 16:00-18:00 的格式，再提交预约`);
        }
        continue;
      }
      if (!overlaps(start, end, timeRange.start, timeRange.end)) continue;
      const matched = matchDevicesFromText(row[4], inventory);
      const mirroredReservation = isSystemMirroredDailyReservation(row, timeRange, systemRecords);
      if (UNIQUE_LOCATIONS.includes(String(row[3] || "").trim()) && !mirroredReservation) {
        locationBlocks.push({
          "状态": "预约中",
          "借用人": row[2] || "日期页手写记录",
          "拍摄场地": String(row[3]).trim(),
          "预约开始时间": timeRange.start,
          "预计归还时间": timeRange.end
        });
      }
      if (isSystemMirroredDailyRow(row, timeRange, matched, systemRecords)) continue;
      for (const device of matched) {
        blocks.push({
          rowNumber: 0,
          "记录ID": `manual_${sheet.sheet_id}_${blocks.length}`,
          "关联借用ID": `manual_${sheet.sheet_id}_${blocks.length}`,
          "状态": "预约中",
          "登记来源": `日期页：${sheet.title}`,
          "借用人": row[2] || "日期页手写记录",
          "联系方式/飞书名": "",
          "拍摄主播": row[2] || "",
          "拍摄场地": row[3] || "",
          "设备ID": device.id,
          "设备名称": device.name,
          "预约开始时间": timeRange.start,
          "预计归还时间": timeRange.end,
          "实际归还时间": "",
          "归还方式": "",
          "管理员确认人": "",
          "是否需管理员确认": device.requiresAdmin ? "是" : "否",
          "管理员确认状态": device.requiresAdmin ? "待确认" : "无需确认",
          "创建时间": "",
          "更新时间": "",
          "备注": row[5] || ""
        });
      }
    }
  }
  return { deviceBlocks: blocks, locationBlocks };
}

function isClosedDailyRow(row) {
  const note = String(row[5] || "");
  return note.includes("【已释放】") || note.includes("【已取消】");
}

function isSameDailySlot(record, timeRange) {
  return toLocalInputValue(new Date(record["预约开始时间"])) === timeRange.start &&
    toLocalInputValue(new Date(record["预计归还时间"])) === timeRange.end;
}

function isSystemMirroredDailyReservation(row, timeRange, systemRecords) {
  const host = String(row[2] || "").trim();
  const location = String(row[3] || "").trim();
  return systemRecords.some((record) => (
    isSameDailySlot(record, timeRange) &&
    String(record["拍摄主播"] || "").trim() === host &&
    String(record["拍摄场地"] || "").trim() === location
  ));
}

function isSystemMirroredDailyRow(row, timeRange, matchedDevices, systemRecords) {
  if (!matchedDevices.length) return false;
  const host = String(row[2] || "").trim();
  const location = String(row[3] || "").trim();
  const deviceIds = new Set(matchedDevices.map((device) => device.id));
  const matchingRecords = systemRecords.filter((record) => (
    isSameDailySlot(record, timeRange) &&
    String(record["拍摄主播"] || "").trim() === host &&
    String(record["拍摄场地"] || "").trim() === location &&
    deviceIds.has(record["设备ID"])
  ));
  return matchingRecords.length > 0 && matchingRecords.length >= matchedDevices.length;
}

function dateTitlesBetween(start, end) {
  const titles = [];
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  const final = new Date(end);
  final.setHours(0, 0, 0, 0);
  while (cursor <= final) {
    titles.push(dailyTitle(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return titles;
}

function parseDailyTimeRange(value, dateValue) {
  const text = String(value || "").normalize("NFKC").replace(/\s+/g, "");
  const match = text.match(/^(\d{1,2}):(\d{2})(?:-|~|—|–|到|至)(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const [, startHour, startMinute, endHour, endMinute] = match.map(Number);
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) return null;
  if (startHour === endHour && startMinute === endMinute) return null;
  const date = parseDailyDate(dateValue);
  if (!date) return null;
  const start = new Date(date);
  start.setHours(Number(match[1]), Number(match[2]), 0, 0);
  const end = new Date(date);
  end.setHours(Number(match[3]), Number(match[4]), 0, 0);
  if (end <= start) end.setDate(end.getDate() + 1);
  return {
    start: toLocalInputValue(start),
    end: toLocalInputValue(end)
  };
}

function parseDailyDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === "number") {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    return new Date(excelEpoch.getTime() + value * 86400000);
  }
  const text = String(value || "").trim();
  const full = text.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (full) return new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]));
  const short = text.match(/^(\d{2})-(\d{1,2})-(\d{1,2})$/);
  if (short) return new Date(2000 + Number(short[1]), Number(short[2]) - 1, Number(short[3]));
  return null;
}

function matchDevicesFromText(text, inventory) {
  const normalized = String(text || "").replace(/\s+/g, "");
  if (!normalized) return [];
  const availableInventory = inventory.filter((item) => item.status !== "停用" && item.status !== "不存在");
  const exactMatches = availableInventory.filter((item) => normalized.includes(item.name.replace(/\s+/g, "")));
  if (exactMatches.length) return exactMatches;

  return availableInventory.filter((item) => {
    const name = item.name.replace(/\s+/g, "");
    if (item.id === "CAM_ZOOM") return normalized.includes("变焦相机") || normalized.includes("索尼变焦");
    if (item.id.startsWith("MIC_DJI")) return normalized.includes("大疆领夹麦") || normalized.includes("大疆麦") || normalized.includes(name.replace("大疆领夹麦-", "大疆"));
    if (item.id === "MIC_MOMA_01") return normalized.includes("猛犸");
    if (item.id.startsWith("MIC_")) return normalized.includes("麦克风") || normalized.includes("领夹麦");
    if (item.id.startsWith("CABLE_MIC_CAM")) return normalized.includes("连接线") || normalized.includes("链接线") || normalized === "线";
    if (item.id.startsWith("BATTERY_SONY")) return normalized.includes("电池") || normalized.includes("索尼相机");
    if (item.id === "CHARGER_SONY_01") return normalized.includes("充电仓");
    return false;
  });
}

async function createBorrowing(payload) {
  const required = ["borrower", "host", "location", "start", "end", "deviceIds"];
  for (const key of required) {
    if (!payload[key] || (Array.isArray(payload[key]) && payload[key].length === 0)) {
      throw new HttpError(400, `缺少字段：${key}`);
    }
  }
  const startAt = new Date(payload.start);
  const endAt = new Date(payload.end);
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
    throw new HttpError(400, "时间格式不正确");
  }
  if (startAt.getTime() >= endAt.getTime()) {
    throw new HttpError(400, "预计归还时间必须晚于开始时间");
  }

  const now = new Date();
  const currentMinute = new Date(now);
  currentMinute.setSeconds(0, 0);
  if (startAt.getTime() < currentMinute.getTime()) {
    throw new HttpError(400, "开始时间不能早于当前时间");
  }

  const availabilityResult = await availabilityDetails(payload.start, payload.end);
  const selected = availabilityResult.items.filter((item) => payload.deviceIds.includes(item.id));
  if (selected.length !== payload.deviceIds.length) throw new HttpError(400, "选择了不存在的设备");
  const blocked = selected.filter((item) => !item.available);
  if (blocked.length) throw new HttpError(409, `以下设备不可用：${blocked.map((item) => item.name).join("、")}`);
  const location = availabilityResult.locations.find((item) => item.name === payload.location);
  if (location && !location.available) {
    throw new HttpError(409, `${payload.location}${location.reason || "在该时段不可用"}`);
  }

  const groupId = `borrow_${compactTimestamp(now)}_${Math.random().toString(36).slice(2, 7)}`;
  const createdAt = toLocalInputValue(now);
  const anyRequiresAdmin = selected.some((item) => item.requiresAdmin);
  const baseStatus = anyRequiresAdmin ? "待确认" : (startAt.getTime() <= now.getTime() ? "借用中" : "预约中");
  const rows = selected.map((item) => [
    `rec_${compactTimestamp(now)}_${item.id}`,
    groupId,
    baseStatus,
    payload.source || "扫码/网页",
    payload.borrower,
    payload.contact || "",
    payload.host || "",
    payload.location || "",
    item.id,
    item.name,
    payload.start,
    payload.end,
    "",
    "",
    "",
    item.requiresAdmin ? "是" : "否",
    item.requiresAdmin ? "待确认" : "无需确认",
    createdAt,
    createdAt,
    payload.note || ""
  ]);

  const config = await loadConfig();
  await appendRows(config.FEISHU_RECORDS_SHEET_ID, rows);

  const dailySheetId = await ensureDailySheet(new Date(payload.start));
  const dailyRemark = [
    anyRequiresAdmin ? "含需管理员确认设备" : "",
    payload.note || ""
  ].filter(Boolean).join("；");
  await appendDailyRow(dailySheetId, {
    start: payload.start,
    end: payload.end,
    host: payload.host || "",
    location: payload.location || "",
    devices: selected.map((item) => item.name).join("、"),
    remark: dailyRemark
  });

  return {
    groupId,
    status: baseStatus,
    requiresAdmin: anyRequiresAdmin,
    devices: selected.map((item) => item.name)
  };
}

function createBorrowingWithLock(payload) {
  const result = borrowQueue.then(() => createBorrowing(payload));
  borrowQueue = result.catch(() => {});
  return result;
}

async function appendDailyRow(sheetId, item) {
  const rows = await readRange(sheetId, "A1:F1000");
  const nextRow = lastUsedRow(rows) + 1;
  const start = new Date(item.start);
  const values = [[
    `${start.getFullYear()}/${start.getMonth() + 1}/${start.getDate()}`,
    `${hhmm(item.start)}-${hhmm(item.end)}`,
    item.host,
    item.location,
    item.devices,
    item.remark
  ]];
  await writeRange(sheetId, `A${nextRow}:F${nextRow}`, values);
}

function lastUsedRow(rows) {
  for (let index = rows.length - 1; index >= 0; index--) {
    if ((rows[index] || []).some((cell) => cell !== null && cell !== undefined && String(cell).trim() !== "")) {
      return index + 1;
    }
  }
  return 1;
}

async function listOpenRecords(filter = {}, options = {}) {
  const records = await readRecords();
  const active = activeStatuses();
  const open = records.filter((record) => active.has(record["状态"]));
  const filtered = open.filter((record) => {
    if (filter.borrower && !record["借用人"].includes(filter.borrower)) return false;
    if (filter.contact && !record["联系方式/飞书名"].includes(filter.contact)) return false;
    return true;
  });
  const groups = new Map();
  for (const record of filtered) {
    const id = record["关联借用ID"];
    if (!groups.has(id)) {
      groups.set(id, {
        groupId: id,
        borrower: record["借用人"],
        contact: record["联系方式/飞书名"],
        status: record["状态"],
        start: record["预约开始时间"],
        end: record["预计归还时间"],
        devices: [],
        rows: []
      });
    }
    const group = groups.get(id);
    group.devices.push(record["设备名称"]);
    group.rows.push(record.rowNumber);
  }
  const systemGroups = [...groups.values()];
  const manualGroups = options.includeManual ? await listManualOpenRecords(records) : [];
  return [...systemGroups, ...manualGroups].sort((a, b) => new Date(a.start) - new Date(b.start));
}

async function listManualOpenRecords(systemRecords = []) {
  const [sheets, inventory] = await Promise.all([getSheets(), readInventory()]);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const dateSheets = sheets.filter((sheet) => {
    const date = parseDailyDate(sheet.title);
    return date && date.getTime() >= startOfToday.getTime();
  });
  const sheetRows = await Promise.all(dateSheets.map(async (sheet) => ({
    sheet,
    rows: await readRange(sheet.sheet_id, "A2:F300")
  })));
  const now = Date.now();
  const groups = [];
  for (const { sheet, rows } of sheetRows) {
    rows.forEach((row, index) => {
      if (isClosedDailyRow(row)) return;
      const timeRange = parseDailyTimeRange(row[1], row[0] || sheet.title);
      if (!timeRange || new Date(timeRange.end).getTime() <= now) return;
      const location = String(row[3] || "").trim();
      const matched = matchDevicesFromText(row[4], inventory);
      if (!matched.length && !UNIQUE_LOCATIONS.includes(location)) return;
      if (isSystemMirroredDailyReservation(row, timeRange, systemRecords)) return;
      groups.push({
        groupId: `manual:${sheet.sheet_id}:${index + 2}`,
        borrower: row[2] || "飞书日期页手写记录",
        contact: "",
        status: "飞书手动预约",
        start: timeRange.start,
        end: timeRange.end,
        devices: matched.length ? matched.map((item) => item.name) : [location],
        location,
        manual: true,
        rows: []
      });
    });
  }
  return groups;
}

async function closeGroup(groupId, options) {
  const manualMatch = String(groupId || "").match(/^manual:([^:]+):(\d+)$/);
  if (manualMatch) {
    if (!options.allowManual) throw new HttpError(403, "飞书手写预约只能由管理员释放");
    const sheetId = manualMatch[1];
    const rowNumber = Number(manualMatch[2]);
    const rows = await readRange(sheetId, `A${rowNumber}:F${rowNumber}`);
    const row = rows[0] || [];
    if (!row.some((cell) => String(cell || "").trim())) throw new HttpError(404, "没有找到这条飞书手写预约");
    if (isClosedDailyRow(row)) throw new HttpError(409, "这条飞书手写预约已经释放或取消");
    const marker = options.status === "已取消" ? "【已取消】" : "【已释放】";
    const note = [row[5] || "", `${marker}${options.admin || "管理员"} ${toLocalInputValue(new Date())}`]
      .filter(Boolean)
      .join("；");
    await writeRange(sheetId, `F${rowNumber}:F${rowNumber}`, [[note]]);
    return { groupId, closed: 1, manual: true };
  }
  const records = await readRecords();
  const matching = records.filter((record) => record["关联借用ID"] === groupId && activeStatuses().has(record["状态"]));
  if (!matching.length) throw new HttpError(404, "没有找到可归还/释放的记录");
  const config = await loadConfig();
  const now = toLocalInputValue(new Date());
  for (const record of matching) {
    const row = RECORD_HEADERS.map((header) => record[header] || "");
    row[2] = options.status || "已归还";
    row[12] = now;
    row[13] = options.method || "自助扫码确认";
    row[14] = options.admin || "";
    row[18] = now;
    if (options.note) row[19] = [row[19], options.note].filter(Boolean).join("；");
    await writeRange(config.FEISHU_RECORDS_SHEET_ID, `A${record.rowNumber}:T${record.rowNumber}`, [row]);
  }
  return { groupId, closed: matching.length };
}

async function adminAction(payload) {
  const config = await loadConfig();
  if (!config.ADMIN_PASSWORD) throw new HttpError(403, "管理员密码还没有配置");
  if (payload.password !== config.ADMIN_PASSWORD) throw new HttpError(403, "管理员密码不正确");
  if (payload.action === "list") return listOpenRecords({}, { includeManual: true });
  if (payload.action === "release") {
    return closeGroup(payload.groupId, {
      status: "已归还",
      method: "管理员线下确认",
      admin: payload.adminName || "管理员",
      note: payload.note || "",
      allowManual: true
    });
  }
  if (payload.action === "cancel") {
    return closeGroup(payload.groupId, {
      status: "已取消",
      method: "管理员取消预约",
      admin: payload.adminName || "管理员",
      note: payload.note || "",
      allowManual: true
    });
  }
  throw new HttpError(400, "未知管理员操作");
}

function dailyTitle(date) {
  const d = new Date(date);
  return `${String(d.getFullYear()).slice(2)}-${d.getMonth() + 1}-${d.getDate()}`;
}

function hhmm(value) {
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function compactTimestamp(date) {
  return date.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function toLocalInputValue(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function columnName(count) {
  let n = count;
  let name = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function parseBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 32 * 1024) throw new HttpError(413, "请求内容过长");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "请求格式不正确");
  }
}

async function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(data));
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) throw new HttpError(403, "Forbidden");
  const ext = path.extname(filePath).toLowerCase();
  const type = ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : "text/html";
  const content = await readFile(filePath);
  response.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
  response.end(content);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === "/api/inventory") {
      return sendJson(response, 200, { items: await readInventory() });
    }
    if (url.pathname === "/api/availability") {
      return sendJson(response, 200, await availabilityDetails(url.searchParams.get("start"), url.searchParams.get("end")));
    }
    if (url.pathname === "/api/borrow" && request.method === "POST") {
      return sendJson(response, 200, await createBorrowingWithLock(await parseBody(request)));
    }
    if (url.pathname === "/api/open-records") {
      return sendJson(response, 200, { records: await listOpenRecords({
        borrower: url.searchParams.get("borrower") || "",
        contact: url.searchParams.get("contact") || ""
      }) });
    }
    if (url.pathname === "/api/return" && request.method === "POST") {
      const body = await parseBody(request);
      return sendJson(response, 200, await closeGroup(body.groupId, { method: "自助扫码确认" }));
    }
    if (url.pathname === "/api/admin" && request.method === "POST") {
      return sendJson(response, 200, await adminAction(await parseBody(request)));
    }
    await serveStatic(request, response);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    sendJson(response, status, { error: error.message || "Server error" });
  }
});

const host = demoMode ? "127.0.0.1" : (process.env.HOST || "127.0.0.1");
server.listen(PORT, host, () => {
  console.log(`设备借用系统${demoMode ? "（本地演示）" : ""}运行于 http://${host}:${server.address().port}`);
});
