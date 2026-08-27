// GFG Tips Distribution — input form.
// Vanilla JS + Firebase (Auth + Firestore), same pattern as the
// recipes.upshiftholdings.com app. No build step -- open index.html
// (served over http/https, not file://) and go.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, collection, getDocs, orderBy, query,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

const DEFAULT_DRIVERS = ["Richard Haselton", "Ross Pullen", "Randy Pruitt"];

let currentRole = null;   // "admin" | "entry" | null
let currentPeriodId = null;
let currentPeriodStatus = null;

// ---------- DOM helpers ----------
const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");
const money = (n) => "$" + (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function setMsg(el, text, kind) {
  el.textContent = text || "";
  el.className = "msg" + (kind ? " " + kind : "");
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
  $("whoamiText").textContent = `${user.email} (${currentRole || "no role assigned"})`;

  if (currentRole === "admin") {
    show($("adminCard"));
    loadAdminList();
  } else {
    hide($("adminCard"));
  }

  if (!currentRole) {
    setMsg($("formMsg"), "Your account isn't assigned a role yet -- ask Rod to add a " +
      "roles/" + user.uid + " document in Firestore.", "error");
    hide($("formCard"));
  } else {
    show($("formCard"));
  }

  // Default the date picker to today if nothing chosen yet.
  if (!$("payDate").value) {
    $("payDate").value = new Date().toISOString().slice(0, 10);
    loadPeriod($("payDate").value);
  }
});

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
