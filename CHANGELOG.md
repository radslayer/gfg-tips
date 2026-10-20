# GFG Payroll (tips repo) — Status & Changelog

Living status doc for this project. Maintained automatically by Claude at
natural stopping points (per Rod's standing instruction, set 2026-10-06) —
don't wait to be asked to update it. Sections are rewritten/condensed when
stale, not just appended to. A fresh Claude session should be able to read
this doc alone and pick up work without replaying prior conversations.

Last updated: 2026-10-20

## Current state / in progress

- **Kitchen Manager bonus formula — STILL unresolved, real money at
  stake. New tooling below does NOT fix this; don't confuse "better
  built" with "verified correct."** Rod flagged (10/9) that payroll and
  Mike Gray's $1,000 Kitchen Manager bonus looked higher than expected.
  A backtest against `bonus_data/weekly_metrics.csv` found 10 of 11
  possible trailing-4-week windows hit the maximum bracket, which
  doesn't reproduce the original "verified" checkpoints from the build
  plan. Rod's working theory: an unintended column was being summed
  into Sales. Partial progress since: on 10/20 Rod confirmed excluding
  order Status "Payment Error" (not a revenue event) -- but that alone
  is too small to explain the discrepancy. More significantly, a
  rebuilt, properly date-bounded calculation (see below) for the
  freshest real period (weeks of 10/4 and 10/11) came out to ratios of
  103.38 and 109.30 -- well below the 120+ range that dominates the
  disputed historical file. That's a data point, not a conclusion:
  Rod has not yet finished reviewing his intended formula against what
  was applied historically. **Do not trust weekly_metrics.csv's
  existing 14 rows, or any bonus amount computed from them, until Rod
  closes this out.**

- **Orders-CSV → Sales automation: built, tested, and deployed
  10/20/2026.** Rod asked to be able to upload the raw orders export
  directly (instead of typing two Sales $ numbers by hand) and get the
  full calculation, bonuses included, ending in an ADP-ready workbook.
  Built as:
  - `bonus_data/compute_weekly_sales.py` -- standalone script, proven
    first in chat against Rod's real Oct 4-18 export ($41,965.95 /
    $42,039.07), confirming each week is bounded strictly by the
    order's own date, not by whatever range the uploaded file covers.
  - Ported into the live app: `report_builder.compute_sales_from_orders_csv`
    (same logic, same two totals reproduced exactly), wired into
    `build_report`/`generate_payroll_report` as an alternative to
    manually-typed Sales. A new "Sales Calc" worksheet shows the work
    (date range enforced, orders included, dollar breakdown, any
    undocumented order status flagged rather than silently included).
  - Frontend: Payroll Report tab now has a toggle -- "Enter manually"
    (unchanged) or "Upload the raw orders export instead" (new file
    input).
  - Verified before deploy: py_compile clean, a full `build_report` dry
    run against Rod's real timeclock + orders files built a complete
    workbook with no errors.
  - **Deployed to `gfg-tips` 10/20/2026** (`firebase deploy --only
    functions --project gfg-tips`, run by Rod -- `generate_payroll_report`
    confirmed as a real update, not a skipped no-op). **Frontend
    (index.html/app.js) is NOT yet live** -- this app's frontend is
    served by GitHub Pages (CNAME → tips.upshiftholdings.com), not
    Firebase Hosting (there's no "hosting" key in firebase.json at all,
    so `--only hosting` silently did nothing in Rod's deploy command).
    Needs a git commit + push to go live; not done yet as of this entry.
  - **Not yet tested live** -- only tested via standalone script, direct
    function calls, and one full offline dry run. First real use should
    be a Preview run (Finalize unchecked), checking the new Sales Calc
    sheet against the already-verified $41,965.95/$42,039.07, before
    ever checking Finalize.

- **Employee roster snapshot added**: `bonus_data/current_employees.csv`,
  confirmed directly with Rod (10/20) -- lets Claude run Sales/Kitchen-
  Hours/bonus calculations in a chat session without needing live
  Firestore or browser access each time. **This is a manually-maintained
  copy, NOT the live source of truth** (Firestore `employees`, edited via
  the app's Employees tab, is what actually drives ADP entries) -- it can
  drift if a department/role changes in the app without also telling
  Claude. Rod accepted that tradeoff since changes are infrequent.
  Current Kitchen (K) roster: Alejandro Gomez, Christina Mata, Donald
  Menifee, Fernando Munoz, Jair Gomez (+ "Jair Gomez 2" timeclock
  variant), Juan Aldana, Justin Freyta, Leticia Lupian, Maria Jaimes,
  Mariana Ortiz, Michael Werner, Rachel Willcutt (+ "Rachael Willcutt"
  variant), Rosa Garcia, Ronnie Padilla, Sam Gray (Mike Gray's son --
  works only when needed, back from college, sparse hours expected).
  Manager (M): Mike Gray (Kitchen Manager bonus role), Thao Nguyen (not
  bonus-eligible). Office (O): Andrea Redlinger, Larry Chillson,
  Michelle Woods. Supervisor bonus role: still unassigned.

- **ADP payroll entry, Sep 20 – Oct 3, 2026 pay period (check date Oct
  9, 2026)**: entered and verified as of 10/9; status not reconfirmed
  since. Should be finalized by now given the elapsed time, but a future
  session should verify rather than assume.

## Decisions made and why

- **Payment Error orders excluded from Sales** (confirmed by Rod,
  10/20): "obviously not a revenue event." Documented alongside the
  existing Tentative/Refund Needed exclusions in `bonus_data/README.md`
  and in the live `compute_sales_from_orders_csv` code. Any status
  Claude hasn't seen before still gets flagged rather than silently
  included or excluded.

- **Date-range enforcement gap found and closed (10/20)**: the Sales
  figures behind `weekly_metrics.csv` had never been bounded by order
  date in committed code -- only by hand, in an earlier unsaved
  session, against whatever file happened to be exported. Confirmed via
  `find . -iname "*.py"` that no script anywhere did this. Fixed by
  writing `bonus_data/compute_weekly_sales.py` (and its in-app port),
  which filters strictly by each order's own date regardless of the
  uploaded file's range. Not yet applied retroactively to the 14
  existing weeks in weekly_metrics.csv -- those remain suspect pending
  Rod's formula review above.

- **Kitchen Manager bonus backtest (10/9) — finding, still open.**
  10 of 11 trailing-4-week windows in weekly_metrics.csv hit the
  maximum 2.0x bracket ($1,000); none reproduce the original plan doc's
  claimed checkpoints. Surcharge-removal alone is too small a change to
  explain the gap. Full numbers already reported to Rod; not repeated
  here to avoid this doc going stale if the underlying file changes.

- **Ronald "Ronnie" Padilla moved from 1099 Contract Labor to W-2**
  (10/6, Rod's call) -- see Known issues for the still-outstanding ADP
  rate mismatch.

- **Alejandro Gomez's "Supervisor" bonus role cleared** (10/6) --
  "disregard him as a supervisor going forward." No replacement tagged.

- **ADP's CC Tips Owed Totals widget mismatch** (10/6 entry session) --
  concluded stale/display-only, not a real data error; self-corrected.

## Open questions (for Rod)

1. **Kitchen Manager/Supervisor bonus formula (urgent, blocks trusting
   any future payout)**: still waiting on your review of the intended
   Sales formula vs. what was actually applied historically. The 10/20
   finding (this period's ratios running 103-109 vs. 120+ historically)
   may be relevant to that review.
2. Does Ronald Padilla's **ADP pay-rate record** need updating to
   $26.00/hr? App config is correct; ADP still shows $20.00/hr.
3. Who (if anyone) gets tagged **"Supervisor"** now that Alejandro's tag
   is cleared? (You mentioned Ronnie Padilla is "a supervisor in
   training" -- unclear if that means tag him now or later.)
4. ~~Bonus data source architecture (SharePoint vs. Graph API)~~ --
   **superseded 10/20**: built as a direct in-app orders-CSV upload
   instead (see Current state). No longer an open question unless Rod
   wants the SharePoint-automatic-pull version on top of this later.

## Known issues deliberately left alone

- Ronald Padilla's ADP pay rate ($20.00/hr) vs. correct current rate
  ($26.00/hr) -- flagged, not changed (Open question 2).
- `bonus_data/` is untracked in git -- holding off on `git add`/commit
  until the Sales formula dispute (Open question 1) is settled, so a
  commit doesn't look like an endorsement of numbers under dispute.
- Frontend (index.html/app.js) changes for the orders-CSV upload
  feature are deployed to the working tree but NOT pushed to GitHub
  Pages yet -- see Current state. The feature is backend-only-live
  until this happens.
- `.deploy-tools/` (a local Firebase CLI install, added 10/20 so Rod
  doesn't have to install it fresh each time) is gitignored -- don't
  commit it, it's ~100MB of node_modules.
- This machine's Claude session has no outbound network access to
  Google/Firebase auth domains (confirmed 10/20 -- blocked by the
  account's egress proxy), so `firebase deploy` must still be run by
  Rod himself from his own terminal; Claude can prepare and verify the
  code but not push it live. Widening that network policy (Admin
  settings -> Capabilities, if Rod is the org owner) would change this.

## Next steps

- **Push the frontend to GitHub Pages** (git commit + push) so the new
  Sales-upload toggle actually appears in the app -- not done yet.
- **Run a Preview (Finalize unchecked) test** of the new orders-CSV
  upload path on a real period before trusting it for a real Finalize.
- Waiting on Rod's review of the Sales formula (Open question 1) --
  top priority, real money involved.
- Resolve Open questions 2-3 with Rod as they come up.
- Decide whether to `git add`/commit `bonus_data/` (hold until Open
  question 1 is settled).
