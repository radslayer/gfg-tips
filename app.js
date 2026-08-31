// GFG Payroll -- input form + payroll requests + employee roster + report.
// Vanilla JS + Firebase (Auth + Firestore + Functions), same pattern as the
// recipes.upshiftholdings.com app. No build step -- open index.html
// (served over http/https, not file://) and go.
//
// Three roles, stored in Firestore as "admin" | "manager" | "entry" but
// displayed as "Owner" | "Manager" | "Entry" (see main.py for why the
// stored string didn't get renamed to match).

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, addDoc, collection, getDocs, orderBy, query, where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getFunctions, httpsCallable,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

const app = initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);

const DEFAULT_DRIVERS = ["Richard Haselton", "Ross Pullen", "Randy Pruitt"];

const ROLE_LABELS = { admin: "Owner", manager: "Manager", entry: "Entry" };

// Which collection each request type writes to, and which field holds its
// amount (hours for PTO, dollars for everything else) -- must match the
// four collections generate_payroll_report reads from in main.py.
const REQ_LABELS = {
  ptoRequests: { amountField: "hours", label: "Hours" },
  employeePurchases: { amountField: "amount", label: "Amount ($)" },
  miscAmounts: { amountField: "amount", label: "Amount ($)" },
  miscReimbursements: { amountField: "amount", label: "Amount ($)" },
};
const REQ_TYPE_DISPLAY = {
  ptoRequests: "PTO",
  employeePurchases: "Employee Purchase",
  miscAmounts: "Delivery / Misc",
  miscReimbursements: "Reimbursement",
};

// Tips periods run every 4 weeks (every other biweekly pay period), always
// on a Friday. First one is 4 weeks after the 8/28/2026 pay date; every
// one after that is another 4 weeks (28 days) later. Generating a long
// list up front means the dropdown never needs to change dynamically --
// extend PAY_PERIOD_COUNT someday if this list ever runs out.
const PAY_PERIOD_START = "2026-09-25";
const PAY_PERIOD_INTERVAL_DAYS = 28;
const PAY_PERIOD_COUNT = 60; // ~4.6 years out

// One-off historical/test periods that don't fall on the generated
// cadence above -- added by hand as needed (e.g. to pressure-test the
// tips calculation against a known real past period).
const EXTRA_PAY_PERIOD_DATES = ["2026-08-14"];

function generatePayPeriodDates(startStr, intervalDays, count) {
  const [y, m, d] = startStr.split("-").map(Number);
  const cur = new Date(y, m - 1, d);
  const dates = [];
  for (let i = 0; i < count; i++) {
    const yyyy = cur.getFullYear();
    const mm = String(cur.getMonth() + 1).padStart(2, "0");
    const dd = String(cur.getDate()).padStart(2, "0");
    dates.push(`${yyyy}-${mm}-${dd}`);
    cur.setDate(cur.getDate() + intervalDays);
  }
  return dates;
}

const PAY_PERIOD_DATES = [
  ...EXTRA_PAY_PERIOD_DATES,
  ...generatePayPeriodDates(PAY_PERIOD_START, PAY_PERIOD_INTERVAL_DAYS, PAY_PERIOD_COUNT),
].sort();

function formatPayDateLabel(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

// Each stacked card is now a "tab section" -- shown one at a time via the
// tab bar once a role has more than one section available to it (Entry
// only ever has one, so Larry never sees a tab bar at all).
const SECTIONS = [
  { id: "formCard", label: "Tip Pool", roles: ["admin", "manager", "entry"] },
  { id: "requestsCard", label: "Payroll Requests", roles: ["admin", "manager"] },
  { id: "employeesCard", label: "Employees", roles: ["admin"] },
  { id: "adminCard", label: "All Periods", roles: ["admin"] },
  { id: "reportCard", label: "Payroll Report", roles: ["admin"] },
];
let activeSectionId = null;

let currentRole = null;   // "admin" | "manager" | "entry" | null
let currentPeriodId = null;
let currentPeriodStatus = null;
let periodDefaultChosen = false;
let lastReportBase64 = null;
let lastReportFilename = null;
let employeesCache = [];  // [{id, name, department, rate, tipEligible}, ...]

// ---------- DOM helpers ----------
const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");
const money = (n) => "$" + (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function setMsg(el, text, kind) {
  el.textContent = text || "";
  el.className = "msg" + (kind ? " " + kind : "");
}

function populatePayDateOptions() {
  const sel = $("payDate");
  sel.innerHTML = "";
  PAY_PERIOD_DATES.forEach((dateStr) => {
    const opt = document.createElement("option");
    opt.value = dateStr;
    opt.textContent = formatPayDateLabel(dateStr);
    sel.appendChild(opt);
  });
}
populatePayDateOptions();

// ---------- Tabs (one section visible at a time, per role) ----------
function showSection(id) {
  activeSectionId = id;
  SECTIONS.forEach((s) => {
    if (s.id === id) show($(s.id)); else hide($(s.id));
  });
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.section === id);
  });
}

function renderTabsForRole(role) {
  const visible = SECTIONS.filter((s) => role && s.roles.includes(role));
  const tabBar = $("tabBar");
  tabBar.innerHTML = "";

  if (visible.length <= 1) {
    // Nothing to tab between -- just show the one section that applies
    // (or none, if this account has no role assigned yet).
    hide(tabBar);
    SECTIONS.forEach((s) => hide($(s.id)));
    activeSectionId = visible.length === 1 ? visible[0].id : null;
    if (activeSectionId) show($(activeSectionId));
    return;
  }

  visible.forEach((s) => {
    const btn = document.createElement("button");
    btn.className = "tab-btn";
    btn.type = "button";
    btn.textContent = s.label;
    btn.dataset.section = s.id;
    btn.addEventListener("click", () => showSection(s.id));
    tabBar.appendChild(btn);
  });
  show(tabBar);
  // Keep whatever tab was already active if it's still valid for this
  // role (role doesn't change mid-session in practice, but this is safe
  // either way); otherwise default to the first tab.
  const keepCurrent = activeSectionId && visible.some((s) => s.id === activeSectionId);
  showSection(keepCurrent ? activeSectionId : visible[0].id);
}

// ---------- Auth ----------
$("signInBtn").addEventListener("click", async () => {
  setMsg($("loginMsg"), "", "");
  const email = $("email").value.trim();
  const password = $("password").value;
  if (!email || !password) {
    setMsg($("loginMsg"), "Enter your email and password.", "error");
    return;
  }
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    setMsg($("loginMsg"), "Sign-in failed: " + err.message, "error");
  }
});

$("signOutBtn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    currentRole = null;
    show($("loginCard"));
    hide($("app"));
    hide($("whoami"));
    return;
  }
  hide($("loginCard"));
  show($("app"));
  show($("whoami"));

  const roleSnap = await getDoc(doc(db, "roles", user.uid));
  currentRole = roleSnap.exists() ? roleSnap.data().role : null;
  const roleLabel = ROLE_LABELS[currentRole] || "no role assigned";
  $("whoamiText").textContent = `${user.email} (${roleLabel})`;

  renderTabsForRole(currentRole);

  if (currentRole === "admin") {
    loadAdminList();
    loadEmployees();
    loadPendingRequests();
  } else if (currentRole === "manager") {
    loadEmployees();
    loadPendingRequests();
  }

  if (!currentRole) {
    setMsg($("formMsg"), "Your account isn't assigned a role yet -- ask Rod to add a " +
      "roles/" + user.uid + " document in Firestore.", "error");
  }

  // Default the dropdown to the earliest period that hasn't been
  // submitted yet -- only figure this out once per session, so we don't
  // yank the user back to it if they've since picked a different date.
  if (!periodDefaultChosen) {
    periodDefaultChosen = true;
    const defaultDate = await pickDefaultPeriod();
    $("payDate").value = defaultDate;
    loadPeriod(defaultDate);
  }
});

async function pickDefaultPeriod() {
  let submitted = new Set();
  try {
    const snap = await getDocs(collection(db, "tipsPeriods"));
    snap.forEach((docSnap) => {
      const data = docSnap.data();
      if (data.status === "submitted") submitted.add(data.payDate || docSnap.id);
    });
  } catch (err) {
    // If this fails for some reason, fall back to the very first period
    // rather than leaving the dropdown unset.
  }
  return PAY_PERIOD_DATES.find((dt) => !submitted.has(dt)) || PAY_PERIOD_DATES[PAY_PERIOD_DATES.length - 1];
}

// ---------- Driver rows ----------
function addDriverRow(name = "", days = "") {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><input type="text" class="driverName" value="${name.replace(/"/g, "&quot;")}" /></td>
    <td><input type="number" step="1" min="0" class="driverDays" value="${days}" style="width:90px" /></td>
    <td><button class="link removeDriverBtn" type="button">remove</button></td>
  `;
  tr.querySelector(".removeDriverBtn").addEventListener("click", () => tr.remove());
  $("driverRows").appendChild(tr);
}

$("addDriverBtn").addEventListener("click", () => addDriverRow());

function resetDriverRows(drivers) {
  $("driverRows").innerHTML = "";
  (drivers && drivers.length ? drivers : DEFAULT_DRIVERS.map((n) => ({ name: n, days: 0 })))
    .forEach((d) => addDriverRow(d.name, d.days));
}

function readDriverRows() {
  return Array.from($("driverRows").querySelectorAll("tr")).map((tr) => ({
    name: tr.querySelector(".driverName").value.trim(),
    days: Number(tr.querySelector(".driverDays").value) || 0,
  })).filter((d) => d.name);
}

// ---------- Net pool live calc ----------
function recomputeNetPool() {
  const total = Number($("totalRevenue").value) || 0;
  const bb = Number($("bonnieBrae").value) || 0;
  const sw = Number($("swift").value) || 0;
  $("netPool").textContent = money(total - bb - sw);
}
["totalRevenue", "bonnieBrae", "swift"].forEach((id) =>
  $(id).addEventListener("input", recomputeNetPool)
);

// ---------- Period load/save ----------
$("payDate").addEventListener("change", () => loadPeriod($("payDate").value));

async function loadPeriod(payDate) {
  if (!payDate) return;
  currentPeriodId = payDate;
  setMsg($("formMsg"), "", "");
  hide($("reportResults"));
  setMsg($("reportMsg"), "", "");
  const snap = await getDoc(doc(db, "tipsPeriods", currentPeriodId));
  if (snap.exists()) {
    const d = snap.data();
    $("totalRevenue").value = d.totalRevenue ?? "";
    $("bonnieBrae").value = d.bonnieBrae ?? "";
    $("swift").value = d.swift ?? "";
    resetDriverRows(d.drivers);
    currentPeriodStatus = d.status || "open";
  } else {
    $("totalRevenue").value = "";
    $("bonnieBrae").value = "";
    $("swift").value = "";
    resetDriverRows(null);
    currentPeriodStatus = "open";
  }
  recomputeNetPool();
  renderPeriodStatus();
  applyEditLock();
}

function renderPeriodStatus() {
  const pill = document.createElement("span");
  pill.className = "status-pill" + (currentPeriodStatus === "submitted" ? " submitted" : "");
  pill.textContent = currentPeriodStatus === "submitted" ? "Submitted" : "Open / draft";
  $("periodStatus").innerHTML = "";
  $("periodStatus").appendChild(pill);
}

function applyEditLock() {
  // Larry (entry) and Mike/Thao (manager, using this as backup) can't edit
  // a period once it's been submitted -- only the Owner can go back and
  // correct it (matches firestore.rules).
  const locked = (currentRole === "entry" || currentRole === "manager") && currentPeriodStatus === "submitted";
  [
    "totalRevenue", "bonnieBrae", "swift", "addDriverBtn", "saveDraftBtn", "submitBtn",
  ].forEach((id) => ($(id).disabled = locked));
  document.querySelectorAll(".driverName, .driverDays, .removeDriverBtn").forEach(
    (el) => (el.disabled = locked)
  );
  if (locked) {
    setMsg($("formMsg"), "This period has already been submitted. Ask Rod if it needs a correction.", "");
  }
}

async function savePeriod(status) {
  if (!currentPeriodId) {
    setMsg($("formMsg"), "Pick a pay date first.", "error");
    return;
  }
  const payload = {
    payDate: currentPeriodId,
    totalRevenue: Number($("totalRevenue").value) || 0,
    bonnieBrae: Number($("bonnieBrae").value) || 0,
    swift: Number($("swift").value) || 0,
    drivers: readDriverRows(),
    status,
    submittedBy: auth.currentUser.email,
    submittedAt: new Date().toISOString(),
  };
  try {
    await setDoc(doc(db, "tipsPeriods", currentPeriodId), payload, { merge: true });
    currentPeriodStatus = status;
    renderPeriodStatus();
    applyEditLock();
    setMsg($("formMsg"), status === "submitted" ? "Submitted." : "Draft saved.", "ok");
    if (currentRole === "admin") loadAdminList();
  } catch (err) {
    setMsg($("formMsg"), "Save failed: " + err.message, "error");
  }
}

$("saveDraftBtn").addEventListener("click", () => savePeriod("open"));
$("submitBtn").addEventListener("click", () => savePeriod("submitted"));

// ---------- Owner: list of all tip periods ----------
async function loadAdminList() {
  const q = query(collection(db, "tipsPeriods"), orderBy("payDate", "desc"));
  const snap = await getDocs(q);
  $("adminRows").innerHTML = "";
  snap.forEach((docSnap) => {
    const d = docSnap.data();
    const net = (d.totalRevenue || 0) - (d.bonnieBrae || 0) - (d.swift || 0);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${d.payDate}</td>
      <td>${d.status === "submitted" ? "Submitted" : "Open / draft"}</td>
      <td>${money(net)}</td>
      <td><button class="link openPeriodBtn" type="button">open</button></td>
    `;
    tr.querySelector(".openPeriodBtn").addEventListener("click", () => {
      $("payDate").value = d.payDate;
      loadPeriod(d.payDate);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    $("adminRows").appendChild(tr);
  });
}

// ---------- Employees (roster) ----------
async function loadEmployees() {
  const q = query(collection(db, "employees"), orderBy("name"));
  const snap = await getDocs(q);
  employeesCache = [];
  snap.forEach((d) => employeesCache.push({ id: d.id, ...d.data() }));
  populateEmployeeDropdown();
  renderEmployeeRows();
}

function populateEmployeeDropdown() {
  const sel = $("reqEmployee");
  const prevValue = sel.value;
  sel.innerHTML = "";
  employeesCache.forEach((e) => {
    const opt = document.createElement("option");
    opt.value = e.name;
    opt.textContent = e.name;
    sel.appendChild(opt);
  });
  if (prevValue && employeesCache.some((e) => e.name === prevValue)) sel.value = prevValue;
}

function renderEmployeeRows() {
  const tbody = $("employeeRows");
  tbody.innerHTML = "";
  employeesCache.forEach((e) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${e.name}</td>
      <td>${e.department || ""}</td>
      <td>${e.rate != null ? Number(e.rate).toFixed(2) : ""}</td>
      <td>${e.tipEligible ? "Yes" : "No"}</td>
    `;
    const editTd = document.createElement("td");
    const editBtn = document.createElement("button");
    editBtn.className = "link";
    editBtn.type = "button";
    editBtn.textContent = "edit";
    editBtn.addEventListener("click", () => {
      $("empName").value = e.name;
      $("empDept").value = e.department || "";
      $("empRate").value = e.rate != null ? e.rate : "";
      $("empTipEligible").value = e.tipEligible ? "y" : "n";
      $("employeesCard").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    editTd.appendChild(editBtn);
    tr.appendChild(editTd);
    tbody.appendChild(tr);
  });
}

$("empSaveBtn").addEventListener("click", async () => {
  setMsg($("empMsg"), "", "");
  const name = $("empName").value.trim();
  const department = $("empDept").value.trim();
  const rateRaw = $("empRate").value;
  const tipEligible = $("empTipEligible").value === "y";
  if (!name) {
    setMsg($("empMsg"), "Enter a name.", "error");
    return;
  }
  try {
    await setDoc(doc(db, "employees", name), {
      name,
      department,
      rate: rateRaw !== "" ? Number(rateRaw) : null,
      tipEligible,
    }, { merge: true });
    setMsg($("empMsg"), "Saved.", "ok");
    $("empName").value = "";
    $("empDept").value = "";
    $("empRate").value = "";
    $("empTipEligible").value = "y";
    loadEmployees();
  } catch (err) {
    setMsg($("empMsg"), "Save failed: " + err.message, "error");
  }
});

$("seedEmployeesBtn").addEventListener("click", async () => {
  setMsg($("seedMsg"), "Loading starting roster...", "");
  $("seedEmployeesBtn").disabled = true;
  try {
    const call = httpsCallable(functions, "seed_employees");
    const res = await call({});
    setMsg($("seedMsg"), `Seeded ${res.data.seeded} employees.`, "ok");
    loadEmployees();
  } catch (err) {
    setMsg($("seedMsg"), "Failed: " + err.message, "error");
  } finally {
    $("seedEmployeesBtn").disabled = false;
  }
});

// ---------- Payroll requests (PTO / purchases / misc / reimbursements) ----------
function updateReqAmountLabel() {
  const info = REQ_LABELS[$("reqType").value];
  $("reqAmountLabel").textContent = info.label;
}
$("reqType").addEventListener("change", updateReqAmountLabel);
updateReqAmountLabel();

// Default the date picker to today, as a convenience.
$("reqDate").value = new Date().toISOString().slice(0, 10);

$("reqSubmitBtn").addEventListener("click", async () => {
  setMsg($("reqMsg"), "", "");
  const type = $("reqType").value;
  const info = REQ_LABELS[type];
  const employeeName = $("reqEmployee").value;
  const amount = Number($("reqAmount").value);
  const date = $("reqDate").value;
  const note = $("reqNote").value.trim();

  if (!employeeName) {
    setMsg($("reqMsg"), "Choose an employee -- if the list is empty, ask Rod to add employees first.", "error");
    return;
  }
  if (!amount || amount <= 0) {
    setMsg($("reqMsg"), `Enter a positive ${info.label.toLowerCase()}.`, "error");
    return;
  }
  if (!date) {
    setMsg($("reqMsg"), "Pick a date.", "error");
    return;
  }

  $("reqSubmitBtn").disabled = true;
  try {
    await addDoc(collection(db, type), {
      employeeName,
      [info.amountField]: amount,
      date,
      note: note || null,
      enteredBy: auth.currentUser.email,
      enteredAt: new Date().toISOString(),
      payrollDate: null,
      recordedAt: null,
      recordedBy: null,
    });
    setMsg($("reqMsg"), "Logged.", "ok");
    $("reqAmount").value = "";
    $("reqNote").value = "";
    loadPendingRequests();
  } catch (err) {
    setMsg($("reqMsg"), "Couldn't log it: " + err.message, "error");
  } finally {
    $("reqSubmitBtn").disabled = false;
  }
});

async function loadPendingRequests() {
  const allRows = [];
  for (const type of Object.keys(REQ_LABELS)) {
    const info = REQ_LABELS[type];
    const q = query(collection(db, type), where("payrollDate", "==", null));
    const snap = await getDocs(q);
    snap.forEach((d) => {
      const data = d.data();
      allRows.push({
        type,
        employeeName: data.employeeName,
        amount: data[info.amountField],
        date: data.date,
        note: data.note,
        enteredBy: data.enteredBy,
      });
    });
  }
  allRows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const tbody = $("pendingRows");
  tbody.innerHTML = "";
  allRows.forEach((r) => {
    const tr = document.createElement("tr");
    const amtDisplay = r.type === "ptoRequests"
      ? (Number(r.amount) || 0).toFixed(2)
      : money(r.amount);
    tr.innerHTML = `
      <td>${REQ_TYPE_DISPLAY[r.type]}</td>
      <td>${r.employeeName}</td>
      <td>${amtDisplay}</td>
      <td>${r.date || ""}</td>
      <td>${r.note || ""}</td>
      <td>${r.enteredBy || ""}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ---------- Owner: Payroll Report ----------
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // reader.result is "data:<mime>;base64,<data>" -- strip the prefix.
      const commaIdx = reader.result.indexOf(",");
      resolve(reader.result.slice(commaIdx + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

$("generateReportBtn").addEventListener("click", async () => {
  setMsg($("reportMsg"), "", "");
  hide($("reportResults"));
  lastReportBase64 = null;
  lastReportFilename = null;

  if (!currentPeriodId) {
    setMsg($("reportMsg"), "Pick a pay period above first.", "error");
    return;
  }
  const csvFile = $("reportCsvFile").files[0];
  if (!csvFile) {
    setMsg($("reportMsg"), "Choose the raw timeclock CSV.", "error");
    return;
  }
  const finalize = $("reportFinalize").checked;

  $("generateReportBtn").disabled = true;
  setMsg($("reportMsg"), "Generating report... this can take a few seconds.", "");
  try {
    const csvBase64 = await readFileAsBase64(csvFile);
    const call = httpsCallable(functions, "generate_payroll_report");
    const res = await call({
      payPeriodId: currentPeriodId,
      csvFilename: csvFile.name,
      csvBase64,
      finalize,
    });
    renderReport(res.data);
    const followUp = res.data.finalized
      ? ` ${res.data.finalizedCount} pending request(s) marked "on ${currentPeriodId}."`
      : " Preview only -- nothing in Firestore changed. Check the box above and re-run to finalize.";
    setMsg($("reportMsg"), "Report generated." + followUp, "ok");
    if (res.data.finalized) loadPendingRequests();
  } catch (err) {
    setMsg($("reportMsg"), "Couldn't generate the report: " + err.message, "error");
  } finally {
    $("generateReportBtn").disabled = false;
  }
});

function renderReport(data) {
  const { summary, warnings, reportBase64, reportFilename } = data;
  lastReportBase64 = reportBase64;
  lastReportFilename = reportFilename;

  const warnEl = $("reportWarnings");
  if (warnings && warnings.length) {
    warnEl.textContent = warnings.join(" ");
    show(warnEl);
  } else {
    warnEl.textContent = "";
    hide(warnEl);
  }

  const empRows = $("reportEmployeeRows");
  empRows.innerHTML = "";
  (summary.employees || []).forEach((e) => {
    const tr = document.createElement("tr");
    const fmt = (v) => (v === null || v === undefined ? "" : (typeof v === "number" ? v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v));
    tr.innerHTML = `
      <td>${e.name}</td><td>${e.department}</td><td>${fmt(e.regularHours)}</td>
      <td>${fmt(e.otHours)}</td><td>${fmt(e.manDays)}</td><td>${fmt(e.ccTipsOwed)}</td>
      <td>${fmt(e.ptoHours)}</td><td>${fmt(e.eePurchases)}</td>
      <td>${fmt(e.miscAmount)}</td><td>${fmt(e.miscReimburse)}</td>
    `;
    empRows.appendChild(tr);
  });

  const drvRows = $("reportDriverRows");
  drvRows.innerHTML = "";
  (summary.drivers || []).forEach((d) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${d.name}</td><td>${d.daysDriven}</td><td>${money(d.tipPayout)}</td>`;
    drvRows.appendChild(tr);
  });

  show($("reportResults"));
}

$("downloadReportBtn").addEventListener("click", () => {
  if (!lastReportBase64) return;
  const byteChars = atob(lastReportBase64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
  const byteArray = new Uint8Array(byteNumbers);
  const blob = new Blob([byteArray], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = lastReportFilename || "Payroll Calculation Report.xlsx";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});
