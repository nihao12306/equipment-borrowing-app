function rangeBounds(range) {
  const [, firstColumn, firstRow, lastColumn, lastRow] = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
  const columnIndex = (letters) =>
    [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  return {
    startRow: Number(firstRow) - 1,
    endRow: Number(lastRow),
    startColumn: columnIndex(firstColumn),
    endColumn: columnIndex(lastColumn) + 1
  };
}

export function createDemoSheets(recordHeaders) {
  const inventoryId = "demo-inventory";
  const recordsId = "demo-records";
  const sheets = [
    { sheet_id: inventoryId, title: "示例设备", rows: [
      ["设备ID", "类别", "设备名称", "状态", "可直接借用", "需管理员确认", "数量", "备注"],
      ["DEMO_CAMERA", "摄像", "演示相机", "可用", "是", "否", 1, ""],
      ["DEMO_MIC", "收音", "演示无线麦克风", "可用", "是", "否", 1, ""],
      ["DEMO_LIGHT", "灯光", "演示补光灯", "可用", "否", "是", 1, ""]
    ] },
    { sheet_id: recordsId, title: "示例借用记录", rows: [[...recordHeaders]] }
  ];
  let nextId = 1;

  return {
    config: {
      FEISHU_INVENTORY_SHEET_ID: inventoryId,
      FEISHU_RECORDS_SHEET_ID: recordsId,
      ADMIN_PASSWORD: "demo"
    },
    readRange(sheetId, range) {
      const { startRow, endRow, startColumn, endColumn } = rangeBounds(range);
      const sheet = sheets.find((item) => item.sheet_id === sheetId);
      return (sheet?.rows ?? []).slice(startRow, endRow)
        .map((row) => (row ?? []).slice(startColumn, endColumn));
    },
    writeRange(sheetId, range, values) {
      const { startRow, startColumn } = rangeBounds(range);
      const sheet = sheets.find((item) => item.sheet_id === sheetId);
      if (!sheet) throw new Error("演示表不存在");
      values.forEach((cells, rowOffset) => {
        const row = sheet.rows[startRow + rowOffset] ??= [];
        cells.forEach((cell, columnOffset) => {
          row[startColumn + columnOffset] = cell;
        });
      });
    },
    getSheets() {
      return sheets.map(({ sheet_id, title }, index) => ({ sheet_id, title, index }));
    },
    addSheet(title, index) {
      const sheetId = `demo-day-${nextId++}`;
      sheets.splice(index, 0, { sheet_id: sheetId, title, rows: [] });
      return { sheetId };
    }
  };
}
