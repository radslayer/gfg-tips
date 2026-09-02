"""
Syncs Firebase Auth custom claims to match the `roles/{uid}` Firestore
collection, for the GFG Payroll app (project gfg-tips).

Why this exists (per Rod, 9/2/2026): firestore.rules used to read a user's
role by doing a get() on roles/{uid} *during rule evaluation*. Every
Firestore Write/Listen request that triggered that get() was failing with
a backend-side INTERNAL error (status code 13) specific to this project's
rules-evaluation service -- confirmed via Cloud Audit Logs, and by
temporarily removing the get() as a diagnostic, which fixed the Tip Pool
page's Save Draft / Submit buttons instantly. The permanent fix moves the
role check onto a custom claim on the user's ID token instead
(request.auth.token.role in the rules), which needs no database read at
rule-evaluation time at all.

roles/{uid} documents are still the human-readable, hand-edited record of
who has what role (edit them in the Firebase console exactly as before).
This script is what actually pushes a role change into effect: run it
after every time you add, remove, or change someone's role doc. It's safe
to re-run any time -- it just re-syncs every uid it finds.

Usage:
    pip install firebase-admin
    # Auth: either set GOOGLE_APPLICATION_CREDENTIALS to a service-account
    # JSON key for the gfg-tips project, or run `gcloud auth application-
    # default login` first (and `gcloud config set project gfg-tips`).
    python sync_role_claims.py

A user who's already signed in when their claim changes won't see the new
access until they get a fresh ID token -- that happens automatically about
once an hour, or immediately if they sign out and back in. Nothing to do
on your end for that; it's just not instant.
"""
import sys

import firebase_admin
from firebase_admin import auth, firestore

VALID_ROLES = {"admin", "manager", "entry"}


def main():
    firebase_admin.initialize_app()
    db = firestore.client()

    docs = list(db.collection("roles").stream())
    if not docs:
        print("No roles/{uid} documents found -- nothing to sync.")
        return

    ok, skipped = 0, 0
    for doc in docs:
        uid = doc.id
        role = (doc.to_dict() or {}).get("role")

        if role not in VALID_ROLES:
            print(f"  SKIP {uid}: role is {role!r}, expected one of {sorted(VALID_ROLES)}")
            skipped += 1
            continue

        try:
            user = auth.get_user(uid)
        except auth.UserNotFoundError:
            print(f"  SKIP {uid}: no matching Firebase Auth user (stale roles doc?)")
            skipped += 1
            continue

        current_claims = user.custom_claims or {}
        if current_claims.get("role") == role:
            print(f"  OK   {uid} ({user.email}): already '{role}', no change needed")
        else:
            auth.set_custom_user_claims(uid, {**current_claims, "role": role})
            print(f"  SET  {uid} ({user.email}): '{current_claims.get('role')}' -> '{role}'")
        ok += 1

    print(f"\nDone. {ok} user(s) synced, {skipped} skipped.")
    if skipped:
        sys.exit(1)


if __name__ == "__main__":
    main()
