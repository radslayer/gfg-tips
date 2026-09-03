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
  getFirestore, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, collection, getDocs, orderBy, query,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getFunctions, httpsCallable,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

const app = initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);

// A human name for "who did this" fields (enteredBy/lastEditedBy) instead
// of a raw email address -- falls back to the email itself for any account
// that doesn't have a display name set in Firebase Auth.
function currentUserLabel() {
  return auth.currentUser.displayName || auth.currentUser.email;
}

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

// Compact "9/3/26" form -- used in the Pending/History request tables,
// which are narrower than the rest of the app, so the full "2026-09-03"
// ISO string doesn't have room and was wrapping mid-word.
function formatShortDate(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-").map(Number);
  return `${m}/${d}/${String(y).slice(2)}`;
}

// Each stacked card is now a "tab section" -- shown one at a time via the
// tab bar once a role has more than one section available to it (Entry
// only ever has one, so Larry never sees a tab bar at all). The old
// Owner-only "All Periods" tab has been folded into the Tip Pool tab
// itself (as a history table below the entry form) so every role that
// can see Tip Pool also sees past periods there -- see loadPeriodsHistory.
const SECTIONS = [
  { id: "formCard", label: "Tip Pool", roles: ["admin", "manager", "entry"] },
  { id: "requestsCard", label: "Payroll Requests", roles: ["admin", "manager"] },
  { id: "employeesCard", label: "Employees", roles: ["admin"] },
  { id: "reportCard", label: "Payroll Report", roles: ["admin"] },
];
let activeSectionId = null;

let currentRole = null;   // "admin" | "manager" | "entry" | null
let currentPeriodId = null;
let currentPeriodStatus = null;
let periodDefaultChosen = false;
let lastReportBase64 = null;
let lastReportFilename = null;
let employeesCache = [];  // admin: [{id, name, department, rate, tipEligible}, ...]
                           // manager: [{id, name}, ...] only -- no wage data
let aliasesCache = [];    // [{id, aliasName, canonicalEmployee, entityLabel}, ...]
let ptoEntriesCache = []; // [{employeeName, startDate, endDate}, ...] for the calendar, refreshed
                           // by loadPayrollRequests -- every PTO request currently on file
                           // (pending or already on a payroll run), since this app has no
                           // separate "approved" flag: a Manager/Owner logging one IS the approval.
const today = new Date();
let ptoCalYear = today.getFullYear();
let ptoCalMonth = today.getMonth(); // 0-11
let editingRequestId = null; // Firestore doc id of the pending request currently
                              // loaded into the form for editing, or null when
                              // the form is in normal "log a new one" mode.

// ---------- DOM helpers ----------
const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");
const money = (n) => "$" + (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function setMsg(el, text, kind) {
  el.textContent = text || "";
  el.className = "msg" + (kind ? " " + kind : "");
}

function populateDateSelect(sel) {
  sel.innerHTML = "";
  PAY_PERIOD_DATES.forEach((dateStr) => {
    const opt = document.createElement("option");
    opt.value = dateStr;
    opt.textContent = formatPayDateLabel(dateStr);
    sel.appendChild(opt);
  });
}
function populatePayDateOptions() {
  populateDateSelect($("payDate"));
  populateDateSelect($("reqPtoPayrollDate"));
}
populatePayDateOptions();

// Which pay period a PTO request should count against, by default: the
// first upcoming pay date on or after the day the time off actually starts
// -- someone can always override this in the dropdown (e.g. PTO that spans
// a pay-period boundary, logged for whichever check they and Rod agree it
// should hit).
function suggestPayPeriodFor(dateStr) {
  return PAY_PERIOD_DATES.find((dt) => dt >= dateStr) || PAY_PERIOD_DATES[PAY_PERIOD_DATES.length - 1];
}

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

  // Past-periods history is visible to anyone with a role at all (Larry
  // included) -- firestore.rules already permits any of the three roles
  // to read every tipsPeriods doc, so this is purely a front-end change.
  if (currentRole) loadPeriodsHistory();

  if (currentRole === "admin") {
    loadEmployees();
    loadPayrollRequests();
    loadSisterAliases();
  } else if (currentRole === "manager") {
    loadEmployees();
    loadPayrollRequests();
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
// Each driver row captures Days Driven (feeds the tip-pool payout, same
// as always) plus their own Deliveries / Setups earnings (feeds the
// "Driver Payroll (1099s) Recap" sheet on the report -- this replaces
// the separate "Driver Payroll and EE Tips" workbook Larry used to
// maintain by hand). Tips is deliberately NOT entered here: in that old
// workbook, "Tips" was a formula pulled from the same tip-pool
// distribution that pays every W2 employee's tip share, so it only has
// a value once the full report runs (net pool split across everyone's
// man-days/days-driven) -- not something Larry can fill in Friday when
// he's just logging days driven and deliveries/setups. The report pulls
// that number automatically from the tip-pool calc (same value shown on
// the "Driver Tip Payouts" sheet); Larry only ever enters the three
// fields below.
function addDriverRow(name = "", days = "", deliveries = "", setups = "") {
  const tr = document.createElement("tr");
  const esc = (v) => String(v ?? "").replace(/"/g, "&quot;");
  tr.innerHTML = `
    <td><input type="text" class="driverName" value="${esc(name)}" /></td>
    <td><input type="number" step="1" min="0" class="driverDays" value="${esc(days)}" style="width:80px" /></td>
    <td><input type="number" step="0.01" min="0" class="driverDeliveries" value="${esc(deliveries)}" style="width:90px" placeholder="$ total" title="Dollar total of all deliveries this driver made this period -- not a count." /></td>
    <td><input type="number" step="0.01" min="0" class="driverSetups" value="${esc(setups)}" style="width:90px" placeholder="$ total" title="Dollar total of all setups this driver did this period -- not a count." /></td>
    <td><button class="link removeDriverBtn" type="button">remove</button></td>
  `;
  tr.querySelector(".removeDriverBtn").addEventListener("click", () => tr.remove());
  $("driverRows").appendChild(tr);
}

$("addDriverBtn").addEventListener("click", () => addDriverRow());

function resetDriverRows(drivers) {
  $("driverRows").innerHTML = "";
  (drivers && drivers.length ? drivers : DEFAULT_DRIVERS.map((n) => ({ name: n, days: 0, deliveries: 0, setups: 0 })))
    .forEach((d) => addDriverRow(d.name, d.days, d.deliveries, d.setups));
}

function readDriverRows() {
  return Array.from($("driverRows").querySelectorAll("tr")).map((tr) => ({
    name: tr.querySelector(".driverName").value.trim(),
    days: Number(tr.querySelector(".driverDays").value) || 0,
    deliveries: Number(tr.querySelector(".driverDeliveries").value) || 0,
    setups: Number(tr.querySelector(".driverSetups").value) || 0,
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
  document.querySelectorAll(
    ".driverName, .driverDays, .driverDeliveries, .driverSetups, .removeDriverBtn"
  ).forEach((el) => (el.disabled = locked));
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
    loadPeriodsHistory();
  } catch (err) {
    setMsg($("formMsg"), "Save failed: " + err.message, "error");
  }
}

$("saveDraftBtn").addEventListener("click", () => savePeriod("open"));
$("submitBtn").addEventListener("click", () => savePeriod("submitted"));

// ---------- Past tip periods (visible to every role, in the Tip Pool tab) ----------
async function loadPeriodsHistory() {
  const q = query(collection(db, "tipsPeriods"), orderBy("payDate", "desc"));
  const snap = await getDocs(q);
  $("periodsHistoryRows").innerHTML = "";
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
    $("periodsHistoryRows").appendChild(tr);
  });
}

// ---------- Employees (roster) ----------
// Admin gets the full roster (name, department, wage rate, tip-eligible)
// straight from Firestore -- reads of `employees` are admin-only in
// firestore.rules. A Manager instead gets only {id, name} from the
// list_employee_names Cloud Function, just enough to populate the "pick
// an employee" dropdown when logging a request on someone's behalf --
// their browser never receives anyone's wage rate (per Rod, 9/2/2026: a
// Manager shouldn't be able to see another employee's pay, front office
// included, even a manager they happen to outrank).
async function loadEmployees() {
  if (currentRole === "admin") {
    const q = query(collection(db, "employees"), orderBy("name"));
    const snap = await getDocs(q);
    employeesCache = [];
    snap.forEach((d) => employeesCache.push({ id: d.id, ...d.data() }));
    renderEmployeeRows();
    if ($("aliasCanonical")) populateAliasEmployeeDropdown();
  } else {
    const call = httpsCallable(functions, "list_employee_names");
    const result = await call();
    employeesCache = result.data.employees || [];
  }
  populateEmployeeDropdown();
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

// ---------- Sister-company aliases (e.g. Easy Entrées) ----------
// Someone punching the clock under an alias name (e.g. "EE Mariana")
// gets those hours folded into the real employee's combined pay for
// wages/OT/tips, with a separate earnout breakdown on the report.
// Owner-only, per firestore.rules -- replaces the old
// sister_company_map.csv file the local script used to read.
async function loadSisterAliases() {
  const snap = await getDocs(collection(db, "sisterCompanyAliases"));
  aliasesCache = [];
  snap.forEach((d) => aliasesCache.push({ id: d.id, ...d.data() }));
  populateAliasEmployeeDropdown();
  renderAliasRows();
}

function populateAliasEmployeeDropdown() {
  const sel = $("aliasCanonical");
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

function renderAliasRows() {
  const tbody = $("aliasRows");
  tbody.innerHTML = "";
  aliasesCache.forEach((a) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${a.aliasName}</td>
      <td>${a.canonicalEmployee}</td>
      <td>${a.entityLabel || ""}</td>
    `;
    const removeTd = document.createElement("td");
    const removeBtn = document.createElement("button");
    removeBtn.className = "link";
    removeBtn.type = "button";
    removeBtn.textContent = "remove";
    removeBtn.addEventListener("click", async () => {
      try {
        await deleteDoc(doc(db, "sisterCompanyAliases", a.id));
        loadSisterAliases();
      } catch (err) {
        setMsg($("aliasMsg"), "Couldn't remove it: " + err.message, "error");
      }
    });
    removeTd.appendChild(removeBtn);
    tr.appendChild(removeTd);
    tbody.appendChild(tr);
  });
}

$("aliasSaveBtn").addEventListener("click", async () => {
  setMsg($("aliasMsg"), "", "");
  const aliasName = $("aliasName").value.trim();
  const canonicalEmployee = $("aliasCanonical").value;
  const entityLabel = $("aliasEntityLabel").value.trim() || "Easy Entrées";
  if (!aliasName) {
    setMsg($("aliasMsg"), "Enter the alias name exactly as it appears on the timeclock.", "error");
    return;
  }
  if (!canonicalEmployee) {
    setMsg($("aliasMsg"), "Choose which employee these hours belong to -- if the list is empty, add employees first.", "error");
    return;
  }
  try {
    await setDoc(doc(db, "sisterCompanyAliases", aliasName), {
      aliasName, canonicalEmployee, entityLabel,
    });
    setMsg($("aliasMsg"), "Saved.", "ok");
    $("aliasName").value = "";
    loadSisterAliases();
  } catch (err) {
    setMsg($("aliasMsg"), "Save failed: " + err.message, "error");
  }
});

// ---------- Payroll requests (PTO / purchases / misc / reimbursements) ----------
function updateReqAmountLabel() {
  const info = REQ_LABELS[$("reqType").value];
  $("reqAmountLabel").textContent = info.label;
}
// PTO can span multiple days (a week off, etc.) -- every other request type
// stays a single date, exactly as before. Total hours for a PTO stretch is
// still just typed in by whoever logs it (same as always); we're only
// additionally recording which actual calendar days it covers.
function updateReqDateFields() {
  const isPto = $("reqType").value === "ptoRequests";
  $("reqDateLabel").textContent = isPto ? "Start date" : "Date";
  $("reqEndDateField").classList.toggle("hidden", !isPto);
  $("reqPtoRangeHint").classList.toggle("hidden", !isPto);
  $("reqPtoPayrollDateField").classList.toggle("hidden", !isPto);
  if (isPto && !$("reqEndDate").value) $("reqEndDate").value = $("reqDate").value;
  // Only re-suggest while logging a brand new PTO request -- while editing
  // an existing one, startEditingRequest sets this explicitly from what's
  // already on file, and this would otherwise stomp on that.
  if (isPto && !editingRequestId) $("reqPtoPayrollDate").value = suggestPayPeriodFor($("reqDate").value);
}
// Employee Purchase is the one request type where we don't take a free-text
// Note -- instead we capture what was bought, the current vendor cost per
// unit, and how many units, and Amount is always the product of those two
// (never hand-typed) so it can't drift from what was actually entered.
// Every other request type keeps a plain, required Note field, same as
// before.
function updateReqPurchaseFields() {
  const isPurchase = $("reqType").value === "employeePurchases";
  $("reqPurchaseFields").classList.toggle("hidden", !isPurchase);
  $("reqNoteField").classList.toggle("hidden", isPurchase);
  $("reqProduct").required = isPurchase;
  $("reqCostPerUnit").required = isPurchase;
  $("reqUnits").required = isPurchase;
  $("reqNote").required = !isPurchase;
  $("reqAmount").readOnly = isPurchase;
  $("reqAmount").classList.toggle("locked", isPurchase);
  $("reqAmountLabel").textContent = REQ_LABELS[$("reqType").value].label + (isPurchase ? " (calculated)" : "");
  if (isPurchase) recomputePurchaseAmount();
}
function recomputePurchaseAmount() {
  const cost = Number($("reqCostPerUnit").value) || 0;
  const units = Number($("reqUnits").value) || 0;
  $("reqAmount").value = (cost * units).toFixed(2);
}
["reqCostPerUnit", "reqUnits"].forEach((id) =>
  $(id).addEventListener("input", recomputePurchaseAmount)
);
$("reqType").addEventListener("change", () => {
  updateReqAmountLabel();
  updateReqDateFields();
  updateReqPurchaseFields();
});
updateReqAmountLabel();
updateReqDateFields();
updateReqPurchaseFields();

// Default the date picker(s) to today, as a convenience.
$("reqDate").value = new Date().toISOString().slice(0, 10);
$("reqEndDate").value = $("reqDate").value;
updateReqDateFields(); // re-run now that reqDate actually has today's value
$("reqDate").addEventListener("change", () => {
  // Keep the end date from trailing before the start date if someone
  // changes the start after already picking an end.
  if ($("reqEndDate").value < $("reqDate").value) $("reqEndDate").value = $("reqDate").value;
  // Re-suggest which paycheck this PTO applies to whenever the start date
  // moves, unless we're editing an existing request (same reasoning as in
  // updateReqDateFields).
  if ($("reqType").value === "ptoRequests" && !editingRequestId) {
    $("reqPtoPayrollDate").value = suggestPayPeriodFor($("reqDate").value);
  }
});

$("reqSubmitBtn").addEventListener("click", async () => {
  setMsg($("reqMsg"), "", "");
  const type = $("reqType").value;
  const info = REQ_LABELS[type];
  const isPto = type === "ptoRequests";
  const isPurchase = type === "employeePurchases";
  const employeeName = $("reqEmployee").value;
  const date = $("reqDate").value;
  const endDate = isPto ? $("reqEndDate").value : date;
  const note = $("reqNote").value.trim();

  const product = $("reqProduct").value.trim();
  const costPerUnit = Number($("reqCostPerUnit").value);
  const units = Number($("reqUnits").value);
  const amount = isPurchase ? Math.round(costPerUnit * units * 100) / 100 : Number($("reqAmount").value);
  const targetPayrollDate = isPto ? $("reqPtoPayrollDate").value : null;

  if (!employeeName) {
    setMsg($("reqMsg"), "Choose an employee -- if the list is empty, ask Rod to add employees first.", "error");
    return;
  }
  if (isPurchase) {
    if (!product) {
      setMsg($("reqMsg"), "Enter what was purchased.", "error");
      return;
    }
    if (!costPerUnit || costPerUnit <= 0) {
      setMsg($("reqMsg"), "Enter the vendor cost per unit.", "error");
      return;
    }
    if (!units || units <= 0) {
      setMsg($("reqMsg"), "Enter how many units were purchased.", "error");
      return;
    }
  } else if (!note) {
    setMsg($("reqMsg"), "Enter a note.", "error");
    return;
  }
  if (!amount || amount <= 0) {
    setMsg($("reqMsg"), `Enter a positive ${info.label.toLowerCase()}.`, "error");
    return;
  }
  if (!date || (isPto && !endDate)) {
    setMsg($("reqMsg"), isPto ? "Pick a start and end date." : "Pick a date.", "error");
    return;
  }
  if (isPto && endDate < date) {
    setMsg($("reqMsg"), "End date can't be before the start date.", "error");
    return;
  }
  if (isPto && !targetPayrollDate) {
    setMsg($("reqMsg"), "Choose which paycheck this PTO should apply to.", "error");
    return;
  }

  const payload = {
    employeeName,
    [info.amountField]: amount,
    date,
    endDate,
    note: isPurchase ? null : note,
    ...(isPurchase ? {
      productPurchased: product,
      costPerUnit,
      unitsPurchased: units,
    } : {}),
    ...(isPto ? { targetPayrollDate } : {}),
  };

  $("reqSubmitBtn").disabled = true;
  try {
    if (editingRequestId) {
      // Type is locked while editing (see startEditingRequest) specifically
      // because each type is its own Firestore collection -- switching type
      // would mean moving the record to a different collection, and these
      // records can never be deleted (see firestore.rules), so there'd be
      // no way to remove it from the old one.
      await updateDoc(doc(db, type, editingRequestId), {
        ...payload,
        lastEditedBy: currentUserLabel(),
        lastEditedAt: new Date().toISOString(),
      });
      setMsg($("reqMsg"), "Updated.", "ok");
      stopEditingRequest();
    } else {
      await addDoc(collection(db, type), {
        ...payload,
        enteredBy: currentUserLabel(),
        enteredAt: new Date().toISOString(),
        payrollDate: null,
        recordedAt: null,
        recordedBy: null,
      });
      setMsg($("reqMsg"), "Logged.", "ok");
      $("reqAmount").value = "";
      $("reqNote").value = "";
      $("reqProduct").value = "";
      $("reqCostPerUnit").value = "";
      $("reqUnits").value = "";
    }
    loadPayrollRequests();
  } catch (err) {
    setMsg($("reqMsg"), (editingRequestId ? "Couldn't save changes: " : "Couldn't log it: ") + err.message, "error");
  } finally {
    $("reqSubmitBtn").disabled = false;
  }
});

// Loads an existing pending request's values into the form above so it can
// be corrected, instead of only ever being able to log new ones. Type stays
// locked (see the comment in the submit handler for why); Employee, Amount/
// Hours, dates, and Note (or the purchase breakdown) are all still editable.
function startEditingRequest(row) {
  editingRequestId = row.id;
  $("reqType").value = row.type;
  $("reqType").disabled = true;
  updateReqAmountLabel();
  updateReqDateFields();
  updateReqPurchaseFields();

  $("reqEmployee").value = row.employeeName;
  $("reqDate").value = row.date;
  $("reqEndDate").value = row.endDate;
  if (row.type === "ptoRequests") {
    // Fall back to a suggestion for PTO logged before this field existed.
    $("reqPtoPayrollDate").value = row.targetPayrollDate || suggestPayPeriodFor(row.date);
  }

  if (row.type === "employeePurchases") {
    $("reqProduct").value = row.productPurchased || "";
    $("reqCostPerUnit").value = row.costPerUnit ?? "";
    $("reqUnits").value = row.unitsPurchased ?? "";
    recomputePurchaseAmount();
  } else {
    $("reqNote").value = row.note || "";
    $("reqAmount").value = row.amount;
  }

  $("reqSubmitBtn").textContent = "Save changes";
  show($("reqCancelEditBtn"));
  setMsg($("reqMsg"),
    `Editing this ${REQ_TYPE_DISPLAY[row.type]} request -- Type can't be changed, but everything else can.`, "");
  $("requestsCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

function stopEditingRequest() {
  editingRequestId = null;
  $("reqType").disabled = false;
  $("reqSubmitBtn").textContent = "Log it";
  hide($("reqCancelEditBtn"));
  setMsg($("reqMsg"), "", "");
  $("reqAmount").value = "";
  $("reqNote").value = "";
  $("reqProduct").value = "";
  $("reqCostPerUnit").value = "";
  $("reqUnits").value = "";
  $("reqDate").value = new Date().toISOString().slice(0, 10);
  $("reqEndDate").value = $("reqDate").value;
  updateReqDateFields();
  updateReqPurchaseFields();
}
$("reqCancelEditBtn").addEventListener("click", stopEditingRequest);

// Fetches every request document (not just pending ones) and splits them
// client-side into "pending" (payrollDate still null, not voided),
// "history" (already swept into a payroll run), and "voided" (excluded from
// payroll but never deleted) -- Managers/Owner can see all three, so a
// request never just disappears from view.
async function loadPayrollRequests() {
  const pendingRows = [];
  const historyRows = [];
  const voidedRows = [];
  ptoEntriesCache = [];
  for (const type of Object.keys(REQ_LABELS)) {
    const info = REQ_LABELS[type];
    const snap = await getDocs(collection(db, type));
    snap.forEach((d) => {
      const data = d.data();
      // Employee Purchase rows show the product/cost/units breakdown in the
      // Note column instead of a free-text note (that field no longer
      // exists for this type) -- older purchase records logged before this
      // change only have a plain note, so those still display as-is.
      const note = (type === "employeePurchases" && data.productPurchased)
        ? `${data.productPurchased} — ${data.unitsPurchased ?? "?"} @ ${money(data.costPerUnit)}/unit`
        : data.note;
      const row = {
        id: d.id,
        type,
        employeeName: data.employeeName,
        amount: data[info.amountField],
        date: data.date,
        endDate: data.endDate || data.date,
        note,
        productPurchased: data.productPurchased,
        costPerUnit: data.costPerUnit,
        unitsPurchased: data.unitsPurchased,
        targetPayrollDate: data.targetPayrollDate || null,
        enteredBy: data.enteredBy,
        payrollDate: data.payrollDate || null,
        voidedAt: data.voidedAt || null,
        voidedBy: data.voidedBy || null,
      };
      if (row.voidedAt) {
        voidedRows.push(row);
      } else {
        (row.payrollDate ? historyRows : pendingRows).push(row);
      }
      // A voided PTO request never actually happens, so it doesn't belong
      // on the calendar.
      if (type === "ptoRequests" && row.date && !row.voidedAt) {
        ptoEntriesCache.push({
          employeeName: row.employeeName,
          startDate: row.date,
          endDate: row.endDate || row.date,
        });
      }
    });
  }
  // Newest first, every list -- so the latest entries stay at the top.
  pendingRows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  historyRows.sort((a, b) => (a.payrollDate < b.payrollDate ? 1 : a.payrollDate > b.payrollDate ? -1 : 0));
  voidedRows.sort((a, b) => (a.voidedAt < b.voidedAt ? 1 : a.voidedAt > b.voidedAt ? -1 : 0));

  renderRequestRows($("pendingRows"), pendingRows, "pending");
  renderRequestRows($("historyRows"), historyRows, "history");
  renderRequestRows($("voidedRows"), voidedRows, "voided");
  renderPtoCalendar();
}

// mode is "pending" (editable + voidable, no payroll-date column),
// "history" (already processed -- read-only, shows which payroll date it
// went out on), or "voided" (excluded from payroll -- read-only except for
// the un-void link that brings it back to Pending).
function renderRequestRows(tbody, rows, mode) {
  tbody.innerHTML = "";
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    const amtDisplay = r.type === "ptoRequests"
      ? (Number(r.amount) || 0).toFixed(2)
      : money(r.amount);
    // Date and Note each carry a small muted sub-line instead of their own
    // column -- Applies-to-payroll under Date (pending PTO only) and
    // Entered-by (and, once voided, voided-by) under Note -- so the table
    // stays narrow enough to fit without a horizontal scrollbar.
    let dateDisplay = `<span class="nowrap">${(r.type === "ptoRequests" && r.endDate && r.endDate !== r.date)
      ? `${formatShortDate(r.date)}–${formatShortDate(r.endDate)}`
      : formatShortDate(r.date)}</span>`;
    if (mode === "pending" && r.type === "ptoRequests" && r.targetPayrollDate) {
      dateDisplay += `<div class="small nowrap">payroll: ${formatShortDate(r.targetPayrollDate)}</div>`;
    }
    let noteDisplay = (r.note || "") + (r.enteredBy ? `<div class="small">— ${r.enteredBy}</div>` : "");
    if (mode === "voided" && r.voidedBy) {
      noteDisplay += `<div class="small">voided by ${r.voidedBy}</div>`;
    }
    tr.innerHTML = `
      <td>${REQ_TYPE_DISPLAY[r.type]}</td>
      <td>${r.employeeName}</td>
      <td>${amtDisplay}</td>
      <td>${dateDisplay}</td>
      <td>${noteDisplay}</td>
      ${mode === "history" ? `<td>${r.payrollDate || ""}</td>` : "<td></td>"}
    `;
    if (mode === "pending") {
      // Only pending requests are editable/voidable -- once payrollDate is
      // stamped, firestore.rules blocks any further edit to the record
      // (it's the permanent record of what actually went into that
      // payroll run).
      const editBtn = document.createElement("button");
      editBtn.className = "link";
      editBtn.type = "button";
      editBtn.textContent = "edit";
      editBtn.addEventListener("click", () => startEditingRequest(r));
      tr.lastElementChild.appendChild(editBtn);

      const voidBtn = document.createElement("button");
      voidBtn.className = "link";
      voidBtn.type = "button";
      voidBtn.textContent = "void";
      voidBtn.style.marginLeft = "8px";
      voidBtn.addEventListener("click", () => voidRequest(r));
      tr.lastElementChild.appendChild(voidBtn);
    } else if (mode === "voided") {
      const unvoidBtn = document.createElement("button");
      unvoidBtn.className = "link";
      unvoidBtn.type = "button";
      unvoidBtn.textContent = "un-void";
      unvoidBtn.addEventListener("click", () => unvoidRequest(r));
      tr.lastElementChild.appendChild(unvoidBtn);
    }
    tbody.appendChild(tr);
  });
}

// Voiding never deletes anything -- payroll requests are a permanent record
// (see firestore.rules) -- it just marks the record so generate_payroll_report
// skips it, and moves it out of Pending into its own Voided list. Un-void
// clears those fields and it's back in Pending exactly as it was.
async function voidRequest(row) {
  if (editingRequestId === row.id) stopEditingRequest();
  try {
    await updateDoc(doc(db, row.type, row.id), {
      voidedAt: new Date().toISOString(),
      voidedBy: currentUserLabel(),
    });
    loadPayrollRequests();
  } catch (err) {
    setMsg($("reqMsg"), "Couldn't void it: " + err.message, "error");
  }
}

async function unvoidRequest(row) {
  try {
    await updateDoc(doc(db, row.type, row.id), {
      voidedAt: null,
      voidedBy: null,
    });
    loadPayrollRequests();
  } catch (err) {
    setMsg($("reqMsg"), "Couldn't un-void it: " + err.message, "error");
  }
}

// ---------- PTO calendar (month view, above the Pending/History tables) ----------
// Pure display -- reads whatever loadPayrollRequests last populated into
// ptoEntriesCache, so switching months never needs another Firestore read.
function pad2(n) { return String(n).padStart(2, "0"); }

function renderPtoCalendar() {
  const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  $("ptoCalLabel").textContent = `${MONTH_NAMES[ptoCalMonth]} ${ptoCalYear}`;

  const firstOfMonth = new Date(ptoCalYear, ptoCalMonth, 1);
  const daysInMonth = new Date(ptoCalYear, ptoCalMonth + 1, 0).getDate();
  const startWeekday = firstOfMonth.getDay(); // 0=Sun

  const grid = $("ptoCalendar");
  grid.innerHTML = "";
  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach((dow) => {
    const el = document.createElement("div");
    el.className = "pto-cal-dow";
    el.textContent = dow;
    grid.appendChild(el);
  });

  for (let i = 0; i < startWeekday; i++) {
    const el = document.createElement("div");
    el.className = "pto-cal-day pto-cal-empty";
    grid.appendChild(el);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${ptoCalYear}-${pad2(ptoCalMonth + 1)}-${pad2(day)}`;
    const cell = document.createElement("div");
    cell.className = "pto-cal-day";
    const num = document.createElement("div");
    num.className = "pto-cal-daynum";
    num.textContent = String(day);
    cell.appendChild(num);

    ptoEntriesCache
      .filter((e) => e.startDate <= dateStr && dateStr <= e.endDate)
      .forEach((e) => {
        const chip = document.createElement("div");
        chip.className = "pto-cal-entry";
        chip.textContent = e.employeeName;
        chip.title = `${e.employeeName}: ${e.startDate} – ${e.endDate}`;
        cell.appendChild(chip);
      });

    grid.appendChild(cell);
  }
}

$("ptoCalPrevBtn").addEventListener("click", () => {
  ptoCalMonth -= 1;
  if (ptoCalMonth < 0) { ptoCalMonth = 11; ptoCalYear -= 1; }
  renderPtoCalendar();
});
$("ptoCalNextBtn").addEventListener("click", () => {
  ptoCalMonth += 1;
  if (ptoCalMonth > 11) { ptoCalMonth = 0; ptoCalYear += 1; }
  renderPtoCalendar();
});

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
    if (res.data.finalized) loadPayrollRequests();
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
    const recapTotal = (Number(d.tips) || 0) + (Number(d.deliveries) || 0) + (Number(d.setups) || 0);
    tr.innerHTML = `
      <td>${d.name}</td><td>${d.daysDriven}</td><td>${money(d.tipPayout)}</td>
      <td>${money(d.tips)}</td><td>${money(d.deliveries)}</td><td>${money(d.setups)}</td>
      <td>${money(recapTotal)}</td>
    `;
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
