// GFG Tips Distribution — input form.
// Vanilla JS + Firebase (Auth + Firestore + Functions), same pattern as the
// recipes.upshiftholdings.com app. No build step -- open index.html
// (served over http/https, not file://) and go.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, collection, getDocs, orderBy, query,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getFunctions, httpsCallable,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

const app = initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);

const DEFAULT_DRIVERS = ["Richard Haselton", "Ross Pullen", "Randy Pruitt"];

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

let currentRole = null;   // "admin" | "entry" | null
let currentPeriodId = null;
let currentPeriodStatus = null;
let periodDefaultChosen = false;
let lastReportBase64 = null;
let lastReportFilename = null;

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
  $("whoamiText").textContent = `${user.email} (${currentRole || "no role assigned"})`;

  if (currentRole === "admin") {
    show($("adminCard"));
    show($("reportCard"));
    loadAdminList();
  } else {
    hide($("adminCard"));
    hide($("reportCard"));
  }

  if (!currentRole) {
    setMsg($("formMsg"), "Your account isn't assigned a role yet -- ask Rod to add a " +
      "roles/" + user.uid + " document in Firestore.", "error");
    hide($("formCard"));
  } else {
    show($("formCard"));
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
  // Larry (entry role) can't edit a period once it's been submitted --
  // only an admin can go back and correct it (matches firestore.rules).
  const locked = currentRole === "entry" && currentPeriodStatus === "submitted";
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

// ---------- Admin: list of all periods ----------
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

// ---------- Admin: Payroll Report ----------
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
  const trackerFile = $("reportTrackerFile").files[0];
  if (!csvFile || !trackerFile) {
    setMsg($("reportMsg"), "Choose both the raw timeclock CSV and the tracker workbook.", "error");
    return;
  }

  $("generateReportBtn").disabled = true;
  setMsg($("reportMsg"), "Generating report... this can take a few seconds.", "");
  try {
    const [csvBase64, trackerBase64] = await Promise.all([
      readFileAsBase64(csvFile),
      readFileAsBase64(trackerFile),
    ]);
    const call = httpsCallable(functions, "generate_payroll_report");
    const res = await call({
      payPeriodId: currentPeriodId,
      csvFilename: csvFile.name,
      csvBase64,
      trackerFilename: trackerFile.name,
      trackerBase64,
    });
    renderReport(res.data);
    setMsg($("reportMsg"), "Report generated.", "ok");
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
