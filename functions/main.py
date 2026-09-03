"""
Cloud Functions for GFG Payroll (formerly "GFG Tips" -- the Firebase
project ID stays `gfg-tips` since that can't be renamed, but the app and
this backend now cover payroll requests too, not just tips).

Three roles, stored in `roles/{uid}` same as before:
  admin   ("Owner" in the UI -- Rod) -- everything.
  manager ("Manager" in the UI -- Mike, Thao) -- can log PTO/purchases/
          misc amount/misc reimbursement requests, and can also use the
          tips-input form as backup for Larry. Can see every employee's
          NAME (list_employee_names, below) but never a wage rate -- rates
          only ever go out via generate_payroll_report and the roster read
          the Employees tab uses, both admin-only.
  entry   ("Entry" -- Larry) -- tips-input form only. No access to
          payroll requests, the employee roster, or report generation.

Every function here does its OWN role check against `roles/{uid}`,
regardless of what the front-end shows or hides -- an Admin SDK call
bypasses Firestore rules entirely, so the rules alone would not be
enough to stop a direct call from someone in the wrong role.
"""
import base64
import os
from datetime import datetime, timedelta, timezone

import firebase_admin
from firebase_admin import firestore
from firebase_functions import https_fn, options, scheduler_fn

import report_builder

firebase_admin.initialize_app()

_EMPLOYEE_SEED_PATH = os.path.join(os.path.dirname(__file__), "employee_config.csv")

_REQUEST_COLLECTIONS = {
    "ptoRequests": "hours",
    "employeePurchases": "amount",
    "miscAmounts": "amount",
    "miscReimbursements": "amount",
}


def _get_role(db, uid):
    doc = db.collection("roles").document(uid).get()
    return doc.to_dict().get("role") if doc.exists else None


def _require_role(req: https_fn.CallableRequest, db, allowed_roles):
    if req.auth is None:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.UNAUTHENTICATED, "Sign in first.")
    role = _get_role(db, req.auth.uid)
    if role not in allowed_roles:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.PERMISSION_DENIED,
            "Your account doesn't have permission to do this.")
    return role


def _load_employees_from_firestore(db):
    """Returns (employees dict, order list) in the same shape
    report_builder expects, read from the `employees` collection."""
    employees = {}
    order = []
    for doc in db.collection("employees").order_by("name").stream():
        d = doc.to_dict()
        name = d.get("name")
        if not name:
            continue
        employees[name] = {
            "department": d.get("department", ""),
            "rate": d.get("rate"),
            "tip_eligible": bool(d.get("tipEligible")),
        }
        order.append(name)
    return employees, order


def _load_sister_map_from_firestore(db):
    """Returns dict alias_name -> {canonical, entity_label} from the
    `sisterCompanyAliases` collection (Owner-maintained via the Employees
    tab). Empty dict if there are no aliases -- report_builder treats
    that as "nothing to fold," same as before this existed."""
    sister_map = {}
    for doc in db.collection("sisterCompanyAliases").stream():
        d = doc.to_dict()
        alias = d.get("aliasName")
        canonical = d.get("canonicalEmployee")
        if not alias or not canonical:
            continue
        sister_map[alias] = {
            "canonical": canonical,
            "entity_label": d.get("entityLabel") or "Easy Entrées",
        }
    return sister_map


@https_fn.on_call(region="us-central1", memory=options.MemoryOption.MB_256, timeout_sec=30)
def seed_employees(req: https_fn.CallableRequest):
    """One-time (idempotent, safe to re-run) upload of the wage table into
    the `employees` Firestore collection, from the bundled CSV this
    function was deployed with. Admin (Owner) only. After this has been
    run once, add/edit employees by writing to Firestore directly (the
    Owner-only 'Employees' admin UI, or the console) -- this callable is
    just the migration path off the old CSV file."""
    db = firestore.client()
    _require_role(req, db, {"admin"})

    import csv
    with open(_EMPLOYEE_SEED_PATH, encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))

    batch = db.batch()
    count = 0
    for row in rows:
        name = row["name"].strip()
        if not name:
            continue
        rate_raw = (row.get("rate") or "").strip()
        doc_ref = db.collection("employees").document(name)
        batch.set(doc_ref, {
            "name": name,
            "department": row["department"].strip(),
            "rate": float(rate_raw) if rate_raw else None,
            "tipEligible": row["tip_eligible"].strip().lower() == "y",
        })
        count += 1
    batch.commit()
    return {"seeded": count}


@https_fn.on_call(region="us-central1", memory=options.MemoryOption.MB_256, timeout_sec=30)
def list_employee_names(req: https_fn.CallableRequest):
    """Admin or Manager. Returns ONLY {id, name} for every employee --
    never rate, department, or tipEligible. This is what powers the "pick
    an employee" dropdown a Manager sees when logging a PTO/Purchase/Misc/
    Reimbursement request on someone's behalf; per Rod (9/2/2026), a
    Manager must never be able to see another employee's wage, so their
    browser is never sent the full record at all -- not hidden by the
    UI, actually never transmitted. (Admin still gets the full roster,
    rate included, via the direct Firestore read the Employees tab uses --
    see firestore.rules, which now restricts that read to admin only.)"""
    db = firestore.client()
    _require_role(req, db, {"admin", "manager"})

    names = []
    for doc in db.collection("employees").order_by("name").stream():
        name = (doc.to_dict() or {}).get("name")
        if name:
            names.append({"id": doc.id, "name": name})
    return {"employees": names}


@https_fn.on_call(region="us-central1", memory=options.MemoryOption.MB_512, timeout_sec=120)
def generate_payroll_report(req: https_fn.CallableRequest):
    """Owner-only. Runs every biweekly pay period now, not just tip weeks
    (fixed 9/3/2026 -- see report_builder.is_tip_week). Builds the payroll
    report from the uploaded raw timeclock CSV plus every currently-pending
    (payrollDate == null), non-voided request in the four payroll-request
    collections -- except PTO, which additionally only counts if its
    targetPayrollDate matches this run's pay_period_id (see the filtering
    below); the other three types always sweep in regardless of pay period.
    On a tip payout week, also pulls the prior biweekly period's driver
    days (if on file) so the tip split covers the full 4-week window --
    see prior_driver_info below and report_builder.build_report's
    docstring for the known W2-side limitation this doesn't yet fix. When
    `finalize` is true, stamps payrollDate + recordedAt/recordedBy on
    every request it used, so it's never picked up again -- this IS the
    official record of "this request was included in payroll on this
    date," replacing the old Excel tracker's 'Recorded in ADP' column.
    When finalize is false, nothing in Firestore is touched -- a safe
    preview."""
    db = firestore.client()
    role = _require_role(req, db, {"admin"})

    data = req.data or {}
    pay_period_id = data.get("payPeriodId")
    csv_b64 = data.get("csvBase64")
    csv_name = data.get("csvFilename") or "timeclock.csv"
    finalize = bool(data.get("finalize"))

    if not pay_period_id:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "Pick a pay period first.")
    if not csv_b64:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "The raw timeclock CSV is required.")

    try:
        pay_date = datetime.strptime(pay_period_id, "%Y-%m-%d")
    except ValueError:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            f"'{pay_period_id}' isn't a YYYY-MM-DD pay date.")

    period_doc = db.collection("tipsPeriods").document(pay_period_id).get()
    if not period_doc.exists:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.NOT_FOUND,
            f"No tipsPeriods document found for '{pay_period_id}'. "
            "Enter and save that period's driver rows (and, on a tip week, "
            "the tip-pool numbers) first.")
    period = period_doc.to_dict()

    try:
        csv_text = base64.b64decode(csv_b64).decode("utf-8-sig")
    except Exception as e:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT, f"Couldn't read the CSV file: {e}")

    employees, order = _load_employees_from_firestore(db)
    if not employees:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.FAILED_PRECONDITION,
            "The employee list is empty -- run 'seed_employees' once first "
            "(Owner only), or add employees in the console.")

    driver_info = {
        d["name"]: {
            "days": d.get("days", 0),
            "deliveries": d.get("deliveries", 0),
            "setups": d.get("setups", 0),
        }
        for d in (period.get("drivers") or [])
        if d.get("name")
    }

    # On a tip payout week, the tip split needs the prior (non-tip) biweekly
    # period's man-days/days-driven too -- see report_builder.is_tip_week /
    # the 9/3/2026 schema fix, which treats W2 employees and 1099 drivers
    # identically here. Drivers' days are Larry's own input, already sitting
    # on the prior tipsPeriods doc; W2 man-days are computed by a report run,
    # so they're only there if that prior period's report was finalized
    # (see the w2ManDays write below) -- if it wasn't, this just comes back
    # empty and build_report's warnings banner says so.
    prior_driver_info = None
    prior_w2_man_days = None
    if report_builder.is_tip_week(pay_date):
        prior_id = (pay_date - timedelta(days=14)).strftime("%Y-%m-%d")
        prior_doc = db.collection("tipsPeriods").document(prior_id).get()
        if prior_doc.exists:
            prior_data = prior_doc.to_dict()
            prior_driver_info = {
                d["name"]: {"days": d.get("days", 0)}
                for d in (prior_data.get("drivers") or [])
                if d.get("name")
            }
            prior_w2_man_days = prior_data.get("w2ManDays") or {}

    sister_map = _load_sister_map_from_firestore(db)

    pending = {}
    for coll_name in _REQUEST_COLLECTIONS:
        docs = db.collection(coll_name).where("payrollDate", "==", None).stream()
        docs_data = [{"id": d.id, **d.to_dict()} for d in docs]
        # A voided request (voidedAt/voidedBy, set from the Payroll Requests
        # tab) is a mistake that was caught before it was ever paid out --
        # it's kept forever for the record, same as everything else, but
        # must never be swept into an actual payroll run.
        docs_data = [d for d in docs_data if not d.get("voidedAt")]
        if coll_name == "ptoRequests":
            # Employee Purchases, Delivery/Misc, and Reimbursements always
            # sweep into whichever payroll run happens next -- that's the
            # existing, correct behavior for those three. PTO is different:
            # someone can request time off weeks or months before they
            # actually take it, and that PTO shouldn't get charged against
            # an earlier paycheck just because it happened to be pending
            # when that earlier report ran. Each PTO request now carries a
            # `targetPayrollDate` (set on the Payroll Requests tab, defaults
            # to the next pay date on/after the time off starts, but can be
            # overridden) naming the exact pay period it should hit, so only
            # PTO scheduled for *this* run's pay_period_id is included here.
            # A record with no targetPayrollDate at all predates this field
            # (added 9/3/2026) and falls back to the old "next report picks
            # it up" behavior so nothing already pending gets stranded.
            docs_data = [
                d for d in docs_data
                if d.get("targetPayrollDate") in (None, pay_period_id)
            ]
        pending[coll_name] = docs_data

    try:
        wb_bytes, summary, warnings, consumed_ids = report_builder.build_report(
            csv_text=csv_text,
            employees=employees,
            order=order,
            pay_date=pay_date,
            raw_csv_name=csv_name,
            total_tip_revenue=float(period.get("totalRevenue") or 0),
            bonnie_brae=float(period.get("bonnieBrae") or 0),
            swift=float(period.get("swift") or 0),
            driver_info=driver_info,
            pending_pto=pending["ptoRequests"],
            pending_purchases=pending["employeePurchases"],
            pending_misc_amt=pending["miscAmounts"],
            pending_misc_reimb=pending["miscReimbursements"],
            sister_map=sister_map,
            prior_driver_info=prior_driver_info,
            prior_w2_man_days=prior_w2_man_days,
        )
    except report_builder.ReportError as e:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.INVALID_ARGUMENT, str(e))

    finalized_count = 0
    if finalize:
        now = datetime.now(timezone.utc).isoformat()
        recorded_by = req.auth.token.get("email", req.auth.uid)
        batch = db.batch()
        for coll_name, ids in consumed_ids.items():
            for doc_id in ids:
                batch.update(db.collection(coll_name).document(doc_id), {
                    "payrollDate": pay_period_id,
                    "recordedAt": now,
                    "recordedBy": recorded_by,
                })
                finalized_count += 1
        # Persist THIS period's own W2 man-days (never the combined tip-week
        # figure) onto this pay period's tipsPeriods doc, so a future tip
        # week's report can pull it back as "prior period" data -- the same
        # role drivers' own "days" field already plays, since Larry enters
        # and saves that directly. Written every finalize, tip week or not,
        # so the chain never has a gap.
        batch.set(
            db.collection("tipsPeriods").document(pay_period_id),
            {"w2ManDays": summary.get("w2ManDaysThisPeriod") or {}},
            merge=True,
        )
        batch.commit()

    return {
        "summary": summary,
        "warnings": warnings,
        "reportBase64": base64.b64encode(wb_bytes).decode("ascii"),
        "reportFilename": f"{pay_period_id} Payroll Calculation Report.xlsx",
        "finalized": finalize,
        "finalizedCount": finalized_count,
    }


@scheduler_fn.on_schedule(schedule="0 3 1 * *", timezone="America/Denver",
                           region="us-central1", memory=options.MemoryOption.MB_256)
def backup_payroll_data(event) -> None:
    """Monthly offsite copy of every payroll-relevant collection, written
    to Cloud Storage as one dated JSON file -- a second, independent copy
    outside Firestore itself. Nothing in this app ever deletes a payroll
    record, but this exists as extra insurance given how late withholding
    problems can surface (per Rod, 8/31/2026)."""
    import json
    from firebase_admin import storage as fb_storage

    db = firestore.client()
    collections = ["employees", "tipsPeriods", "roles", "sisterCompanyAliases"] + list(_REQUEST_COLLECTIONS)
    dump = {}
    for coll_name in collections:
        dump[coll_name] = [
            {"id": d.id, **d.to_dict()} for d in db.collection(coll_name).stream()
        ]

    bucket = fb_storage.bucket()
    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    blob = bucket.blob(f"backups/gfg-payroll-{date_str}.json")
    blob.upload_from_string(
        json.dumps(dump, default=str, indent=2), content_type="application/json")
