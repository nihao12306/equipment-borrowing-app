const state = {
  devices: [],
  selected: new Set(),
  locations: new Map(),
  availabilityRequest: 0
};

const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value).replace(/[&<>"']/g, (character) => entities[character]);
}

function localValue(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function plusHours(hours) {
  return localValue(new Date(Date.now() + hours * 60 * 60 * 1000));
}

function currentMinuteValue() {
  const now = new Date();
  now.setSeconds(0, 0);
  return localValue(now);
}

function updateTimeMinimums(form) {
  const currentMinute = currentMinuteValue();
  form.start.min = currentMinute;
  if (form.start.value && form.start.value < currentMinute) {
    form.start.value = currentMinute;
  }
  form.end.min = form.start.value && form.start.value > currentMinute ? form.start.value : currentMinute;
}

function rememberIdentity(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  localStorage.setItem("equipmentUser", JSON.stringify({
    borrower: data.borrower || "",
    contact: data.contact || "",
    host: data.host || "",
    location: data.location || ""
  }));
}

function restoreIdentity() {
  const saved = JSON.parse(localStorage.getItem("equipmentUser") || "{}");
  for (const [key, value] of Object.entries(saved)) {
    const input = document.querySelector(`[name="${key}"]`);
    if (input && value) input.value = value;
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active"));
      document.querySelectorAll(".view").forEach((item) => item.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(tab.dataset.view).classList.add("active");
    });
  });
}

async function loadInventory() {
  const data = await api("/api/inventory");
  state.devices = data.items;
  $("#statusLine").textContent = `已读取 ${data.items.length} 个设备项`;
  renderDevices(data.items);
  await refreshAvailability();
}

function renderDevices(devices) {
  const list = $("#deviceList");
  list.innerHTML = "";
  let currentCategory = "";
  for (const item of devices) {
    if (item.category !== currentCategory) {
      currentCategory = item.category;
      const category = document.createElement("div");
      category.className = "category";
      category.textContent = currentCategory || "其他";
      list.appendChild(category);
    }
    const row = document.createElement("div");
    row.className = "device";
    const disabled = item.available === false || item.status === "停用" || item.status === "不存在";
    if (disabled) state.selected.delete(item.id);
    const needsConfirm = item.requiresAdmin && item.status !== "停用" && item.status !== "不存在";
    const reasonText = item.reason && item.reason !== item.status ? item.reason : "";
    row.innerHTML = `
      <label>
        <input type="checkbox" value="${escapeHtml(item.id)}" ${disabled ? "disabled" : ""}>
        <span>
          <span class="name">${escapeHtml(item.name)}</span>
          <span class="meta">${escapeHtml(item.status || "")}${needsConfirm ? " · 需管理员确认" : ""}</span>
          ${reasonText ? `<span class="meta bad">${escapeHtml(reasonText)}</span>` : ""}
          ${item.note ? `<span class="meta">${escapeHtml(item.note)}</span>` : ""}
        </span>
      </label>
    `;
    const checkbox = row.querySelector("input");
    checkbox.checked = state.selected.has(item.id) && !disabled;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selected.add(item.id);
      else state.selected.delete(item.id);
    });
    list.appendChild(row);
  }
}

async function refreshAvailability() {
  const form = $("#borrowForm");
  const data = Object.fromEntries(new FormData(form).entries());
  if (!data.start || !data.end) return;
  const requestId = ++state.availabilityRequest;
  $("#statusLine").textContent = "正在查询最新占用情况…";
  const result = await api(`/api/availability?start=${encodeURIComponent(data.start)}&end=${encodeURIComponent(data.end)}`);
  if (requestId !== state.availabilityRequest) return;
  state.devices = result.items;
  state.locations = new Map((result.locations || []).map((item) => [item.name, item]));
  renderDevices(result.items);
  renderLocationStatus(data.location);
  $("#statusLine").textContent = `空闲状态已更新，共 ${result.items.length} 个设备项`;
}

function renderLocationStatus(locationName) {
  const line = $("#locationStatus");
  const location = state.locations.get(locationName);
  line.className = "meta";
  if (!locationName || !location) {
    line.textContent = "";
    return;
  }
  line.textContent = location.available ? `${locationName}在该时段可预约` : location.reason;
  line.classList.add(location.available ? "ok" : "bad");
}

function setupBorrow() {
  const form = $("#borrowForm");
  form.start.value = currentMinuteValue();
  form.end.value = plusHours(3);
  updateTimeMinimums(form);
  $("#refreshAvailability").addEventListener("click", () => refreshAvailability().catch(showError));
  let refreshTimer;
  for (const field of [form.start, form.end, form.location]) {
    field.addEventListener("change", () => {
      updateTimeMinimums(form);
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => refreshAvailability().catch(showError), 250);
    });
  }
  for (const field of [form.start, form.end]) {
    field.addEventListener("focus", () => updateTimeMinimums(form));
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    const originalLabel = submitButton.textContent;
    submitButton.textContent = "正在保存…";
    $("#submitStatus").textContent = "正在保存借用登记。";
    try {
      rememberIdentity(form);
      const data = Object.fromEntries(new FormData(form).entries());
      if (new Date(data.start).getTime() < new Date(`${currentMinuteValue()}:00`).getTime()) {
        throw new Error("开始时间不能早于当前时间");
      }
      data.deviceIds = [...state.selected];
      if (!data.deviceIds.length) throw new Error("请至少选择一件设备");
      const location = state.locations.get(data.location);
      if (location && !location.available) throw new Error(location.reason);
      data.source = "扫码/网页";
      const result = await api("/api/borrow", {
        method: "POST",
        body: JSON.stringify(data)
      });
      alert(result.requiresAdmin ? "已提交，包含需管理员确认的设备。" : "登记成功。");
      $("#submitStatus").textContent = "借用登记成功。";
      state.selected.clear();
      await refreshAvailability();
    } catch (error) {
      $("#submitStatus").textContent = error.message || "提交失败，请重试。";
      showError(error);
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = originalLabel;
    }
  });
}

function setupReturn() {
  $("#returnSearch").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    const result = await api(`/api/open-records?borrower=${encodeURIComponent(data.borrower || "")}&contact=${encodeURIComponent(data.contact || "")}`);
    renderRecords("#returnList", result.records, [
      {
        label: "确认归还",
        run: async (record) => {
          await api("/api/return", { method: "POST", body: JSON.stringify({ groupId: record.groupId }) });
          alert("已确认归还。");
          $("#returnSearch").dispatchEvent(new Event("submit", { cancelable: true }));
        }
      }
    ]);
  });
}

function setupAdmin() {
  $("#adminForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    const records = await api("/api/admin", {
      method: "POST",
      body: JSON.stringify({ action: "list", password: data.password })
    });
    renderRecords("#adminList", records, [
      {
        label: "线下确认归还",
        run: async (record) => {
          await api("/api/admin", {
            method: "POST",
            body: JSON.stringify({
              action: "release",
              groupId: record.groupId,
              password: data.password,
              adminName: data.adminName
            })
          });
          alert("已释放设备。");
          form.dispatchEvent(new Event("submit", { cancelable: true }));
        }
      },
      {
        label: "取消预约",
        run: async (record) => {
          await api("/api/admin", {
            method: "POST",
            body: JSON.stringify({
              action: "cancel",
              groupId: record.groupId,
              password: data.password,
              adminName: data.adminName
            })
          });
          alert("已取消预约。");
          form.dispatchEvent(new Event("submit", { cancelable: true }));
        }
      }
    ]);
  });
}

function renderRecords(selector, records, actions) {
  const list = $(selector);
  list.innerHTML = "";
  if (!records.length) {
    list.innerHTML = `<div class="record"><span class="meta">没有找到未完成记录</span></div>`;
    return;
  }
  for (const record of records) {
    const item = document.createElement("div");
    item.className = "record";
    item.innerHTML = `
      <div class="name">${escapeHtml(record.borrower || "未填写借用人")} · ${escapeHtml(record.status)}</div>
      <div class="meta">${escapeHtml(record.start)} 到 ${escapeHtml(record.end)}</div>
      <div>${escapeHtml(record.devices.join("、"))}</div>
      <div class="record-actions"></div>
    `;
    const actionBox = item.querySelector(".record-actions");
    for (const action of actions) {
      const button = document.createElement("button");
      button.textContent = action.label;
      button.addEventListener("click", () => action.run(record).catch(showError));
      actionBox.appendChild(button);
    }
    list.appendChild(item);
  }
}

function showError(error) {
  alert(error.message || String(error));
}

setupTabs();
setupBorrow();
setupReturn();
setupAdmin();
restoreIdentity();
loadInventory().catch(showError);
