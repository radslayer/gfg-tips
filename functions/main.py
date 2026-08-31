"""
Cloud Function for the GFG Tips admin-only Payroll Report page.

Security: this is a Firebase Callable Function (onCall). The Firebase
client SDK automatically attaches the signed-in user's ID token, and the
Functions runtime verifies it before this code ever runs -- but that only
proves WHO is calling, not that they're allowed to. This function does its
OWN role check against the `roles/{uid}` Firestore collection (the same
collection firestore.rules already uses) and rejects anyone who isn't
role "admin", regardless of what the front-end shows or hides. Larry
(role "entry") calling this function directly -- bypassing the UI
entirely -- gets rejected the same way.

No file ever touches Cloud Storage: the two uploaded files (raw timeclock
CSV, Employee Time Off Tracker workbook) and the generated report all
travel as base64 in the request/response bodies and live only in this
function's memory for the few seconds it runs. Simpler surface, nothing
extra to lock down.
"""
import base64
import os
from datetime import datetime

import firebase_admin
from firebase_admin import firestore
from firebase_functions import https_fn, options

import report_builder

firebase_admin.initialize_app()

_EMPLOYEE_CONFIG_PATH = os.path.join(os.path.dirname(__file__), "employee_config.csv")
with open(_EMPLOYEE_CONFIG_PATH, encoding="utf-8-sig") as _f:
    _EMPLOYEE_CONFIG_TEXT = _f.read()


@https_fn.on_call(region="us-central1", memory=options.MemoryOption.MB_512, timeout_sec=120)
def generate_payroll_report(req: https_fn.CallableRequest):
    if req.auth is None:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.UNAUTHENTICATED, "Sign in first.")

    db = firestore.client()
    role_doc = db.collection("roles").document(req.auth.uid).get()
    role = role_doc.to_dict().get("role") if role_doc.exists else None
    if role != "admin":
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.PERMISSION_DENIED,
            "Only an admin can generate the payroll report.")

    data = req.data or {}
    pay_period_id = data.get("payPeriodId")
    csv_b64 = data.get("csvBase64")
    csv_name = data.get("csvFilename") or "timeclock.csv"
    tracker_b64 = data.get("trackerBase64")
    tracker_name = data.get("trackerFilename") or "Employee Time Off Tracker.xlsx"

    if not pay_period_id:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "Pick a pay period first.")
    if not csv_b64 or not tracker_b64:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "Both the raw timeclock CSV and the Employee Time Off Tracker file are required.")

    period_doc = db.collection("tipsPeriods").document(pay_period_id).get()
    if not period_doc.exists:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.NOT_FOUND,
            f"No tipsPeriods document found for '{pay_period_id}'. "
            "Enter and save that period's tip-pool numbers first.")
    period = period_doc.to_dict()

    try:
        pay_date = datetime.strptime(pay_period_id, "%Y-%m-%d")
    except ValueError:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            f"'{pay_period_id}' isn't a YYYY-MM-DD pay date.")

    try:
        csv_text = base64.b64decode(csv_b64).decode("utf-8-sig")
    except Exception as e:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT, f"Couldn't read the CSV file: {e}")
    try:
        tracker_bytes = base64.b64decode(tracker_b64)
    except Exception as e:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT, f"Couldn't read the tracker file: {e}")

    driver_days = {
        d["name"]: d.get("days", 0)
        for d in (period.get("drivers") or [])
        if d.get("name")
    }

    try:
        wb_bytes, summary, warnings = report_builder.build_report(
            csv_text=csv_text,
            tracker_bytes=tracker_bytes,
            employee_config_text=_EMPLOYEE_CONFIG_TEXT,
            pay_date=pay_date,
            raw_csv_name=csv_name,
            tracker_name=tracker_name,
            total_tip_revenue=float(period.get("totalRevenue") or 0),
            bonnie_brae=float(period.get("bonnieBrae") or 0),
            swift=float(period.get("swift") or 0),
            driver_days=driver_days,
        )
    except report_builder.ReportError as e:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.INVALID_ARGUMENT, str(e))
    except KeyError as e:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            f"The tracker workbook is missing an expected sheet: {e}. "
            "Is this the Employee Time Off Tracker file?")

    return {
        "summary": summary,
        "warnings": warnings,
        "reportBase64": base64.b64encode(wb_bytes).decode("ascii"),
        "reportFilename": f"{pay_period_id} Payroll Calculation Report.xlsx",
    }
