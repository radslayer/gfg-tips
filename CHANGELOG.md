# GFG Payroll (tips repo) — Status & Changelog

Living status doc for this project. Maintained automatically by Claude at
natural stopping points (per Rod's standing instruction, set 2026-10-06) —
don't wait to be asked to update it. Sections are rewritten/condensed when
stale, not just appended to. A fresh Claude session should be able to read
this doc alone and pick up work without replaying prior conversations.

Last updated: 2026-10-23

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
  - **Fully deployed 10/20/2026.** Backend via `firebase deploy --only
    functions --project gfg-tips` (run by Rod -- `generate_payroll_report`
    confirmed as a real update, not a skipped no-op). Frontend via git
    commit `ad2a644` + `git push origin main` (run by Rod) -- this app's
    frontend is served by GitHub Pages (CNAME → tips.upshiftholdings.com),
    not Firebase Hosting (there's no "hosting" key in firebase.json at
    all, so `--only hosting` silently did nothing in the deploy command).
    GitHub Pages takes a minute or two to rebuild after a push.
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

- **ADP payroll entry, Oct 4 – Oct 17, 2026 pay period (check date Oct
  23, 2026) -- IN PROGRESS as of 10/23.** Report finalized in the GFG
  Payroll app (orders-CSV Sales path, not a tip week, Supervisor bonus
  week but no one tagged so $0 paid -- see warnings banner). Claude
  pulled the finalized numbers directly from the app's live DOM (not
  the flaky .xlsx download, which twice failed to land before it could
  be read) and is populating ADP RUN's "Enter payroll" grid for the 17
  hourly employees with activity this period plus the two salaried
  managers (whose Salary Amount/2% S-Corp Medical were already correct
  on ADP's own profile, untouched). Regular/Overtime/PTO/Misc Amount
  entered inline; the 6 nonzero "Employee Purchases" deductions
  (Christina Mata $33.99, Donald Menifee $3.20, Maria Jaimes $15.52,
  Michael Werner $89.71, Michelle Woods $43.82, Rosa Garcia $45.37)
  entered via each employee's "..." -> One-time overrides -> Deductions
  -> "Employee purchases" field, per Rod -- ADP's payroll grid has no
  dedicated column for this, only the overrides path. Not yet
  submitted/finalized in ADP -- standing rule: populate only, Rod
  reviews and finalizes himself.

## Decisions made and why

- **Rod's 2% S-Corp Medical figure updated to $781.29/period (10/23/2026, per Guapo -- new amount advised going forward; he's entering it in ADP himself).** Updated the matching hardcoded constant in `report_builder.py` from the old $677.12 to $781.29 (`ROD_MEDICAL_AMOUNT`, line ~193) purely for consistency -- this column isn't actually read from this report for Rod's pay (see the entry above: his Medical/Salary figures live directly on his ADP profile), so this was a documentation-cleanliness update, not a pay-accuracy fix. `ROD_MEDICAL_THIRD_PERIOD` (the $0 exception on the 3rd biweekly pay date of a month) was left unchanged -- not mentioned as changing.

- **ADP Entry sheet now ordered to match ADP's own "Enter payroll"
  screen (10/23/2026, per Rod): Managers, then Office, then Kitchen,
  alphabetized by LAST name within each group.** Previously the sheet
  just followed Firestore's `employees` query order (alphabetical by
  first name -- an accident of how `_load_employees_from_firestore`
  queries, never an intentional ordering). Fixed in
  `report_builder.build_report`: every row (the hardcoded Rod template
  AND the Firestore-driven salaried/hourly rows) is now collected into
  specs first, sorted by (department rank M/O/K, last-name key), and
  only then written -- so write_row's call order (which is what
  determines sheet row order) is the sorted order. Last-name key prefers
  the confirmed ADP name's "Last, First" prefix (handles compound
  surnames like "Gomez Garcia, Alejandro" correctly, the way a plain
  last-token split of the app's own "First Last" name wouldn't), falling
  back to the last whitespace token of the app's own name when no ADP
  name is confirmed yet. Verified against the real 22-person roster with
  a direct `build_report` call, reading the actual generated "ADP Entry"
  sheet's row order back out -- confirmed correct grouping and
  alphabetization in all three department groups.

- **Fixed: Rod appeared TWICE on the ADP Entry sheet -- resolved
  10/23/2026 (per Guapo).** Found while verifying the row-order fix above:
  he's both the hardcoded `SALARIED_TEMPLATE_ROWS` entry (`Name: "Rod"`,
  `AdpName: "Salyer, Rod"`, which carries the 2% S-Corp Medical amount via
  `ROD_ROW_NAME`) AND a normal Firestore `employees` doc (`"Rod Salyer"`,
  Salaried, Department M). Asked Guapo which was closer to reality: he
  doesn't track PTO/Employee Purchases/Misc Amounts for himself, and his
  real Salary Amount AND 2% S-Corp Medical are hardwired directly into his
  ADP profile -- neither is read off this report by anyone, so the
  Medical-figure discrepancy between the two rows never actually mattered
  for pay accuracy. It was purely cosmetic duplication. Fixed by adding
  `TEMPLATE_COVERED_FIRESTORE_NAMES = {"Rod Salyer"}` (defined right next
  to `SALARIED_TEMPLATE_ROWS`) and skipping those names in the Firestore
  `order` loop that builds `row_specs`, so only the hardcoded "Salyer,
  Rod" template row (the one with the ADP-confirmed "Last, First" display
  name) survives. The Firestore "Rod Salyer" doc itself was left alone --
  not deleted, in case it's used for something else (e.g. employee
  pickers) -- it just no longer gets its own row on this sheet. Verified
  with a direct re-run of the real row_specs/sort logic (imported from the
  module, not retyped) against a small representative roster: exactly one
  Rod row survives, and it's the correct one. If any other salaried person
  ever ends up in both places at once, add their Firestore name to
  `TEMPLATE_COVERED_FIRESTORE_NAMES` the same way.

- **Unrecognized timeclock names now flagged with hours, loudly, never
  silently dropped (10/23/2026, per Rod: "We cannot fail to pay someone
  because you don't recognize them as an employee or because we have not
  entered them into ADP yet. Always assume the timeclock import is
  right.")** A warning for this already existed (`compute_hours_and_wages`
  has always excluded any timeclock name not matched to a roster entry
  with a rate), but it only named the person, not how many hours they
  worked -- so acting on it meant going back to the raw export by hand.
  Fixed in `report_builder.build_report`: a genuinely-unrecognized name
  (not in the `employees` roster at all -- as opposed to a roster name
  still missing a rate, which already has its own correctly-worded
  warning) now gets a dedicated, loud warning listing their actual hours
  from the timeclock, e.g. "Mystery Person (13.75 hrs)", with explicit
  instructions to either add them to the Employees tab or pay them
  directly in ADP by hand. Verified with a real `build_report` call
  against synthetic timeclock data (not just read the code) -- confirmed
  the new warning fires with the correct summed hours, and confirmed it
  does NOT fire for a roster employee who's merely missing a rate (that
  stays on the existing, separately-worded `rate_missing_names` warning,
  so nobody reads "not on your roster" about someone who actually is).
  Directly relevant to the Thomas/Randy Pruitt watch item above -- if he
  ever shows up in a timeclock export before being added to the roster,
  this is what will now catch it loudly instead of his hours just
  vanishing.

  Also found and fixed the same gap in the OTHER place this already
  surfaces: the Payroll Report tab has a dedicated "Unknown timeclock
  names" panel (right below the warnings banner) with one-click "Add as
  employee" / "Add as sister-company alias" / "Add as Contract Labor"
  buttons per name -- arguably the more important surface since it's the
  one with the actual fix-it buttons, not just text. It also only showed
  a bare name, no hours. `summary.unknownTimeclockNames` is now a list of
  `{name, hours}` (was bare strings) and `app.js`'s
  `renderUnknownTimeclockNames` shows "Name (X.XX hrs)" in that panel,
  still accepting a bare-string array defensively in case the frontend
  gets deployed before the backend. Verified with `node --check app.js`
  (syntax) and the same real `build_report` test above, which confirmed
  `unknownTimeclockNames` now carries hours for both the truly-unknown
  name and the known-but-no-rate name.

  **Not yet deployed** -- needs `firebase deploy --only functions
  --project gfg-tips` AND a `git push` (app.js changed too) from Rod (see
  Known issues: no outbound network access to Firebase/GitHub from this
  session).

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
2. ~~Does Ronald Padilla's ADP pay-rate record need updating to
   $26.00/hr?~~ -- **resolved 10/23**: confirmed by Rod, $26.00/hr is
   correct. ADP already shows it as a rate scheduled to update on the
   10/23 payroll run, so nothing needed changing.
3. Who (if anyone) gets tagged **"Supervisor"** now that Alejandro's tag
   is cleared? (You mentioned Ronnie Padilla is "a supervisor in
   training" -- unclear if that means tag him now or later.)
4. ~~Bonus data source architecture (SharePoint vs. Graph API)~~ --
   **superseded 10/20**: built as a direct in-app orders-CSV upload
   instead (see Current state). No longer an open question unless Rod
   wants the SharePoint-automatic-pull version on top of this later.
5. **New (10/23): "Thomas Pruitt" / "Randy Pruitt."** ADP has a W2
   employee "Pruitt, Thomas R" ($20.00/hr) who doesn't exist in this
   app's Firestore `employees` roster at all. Per Rod: mostly drives for
   GFG, punches (if ever) as "Randy Pruitt" in TimePilot, expected to
   start working the kitchen before year-end 2026. He had zero punches
   in the 10/4-10/17 timeclock export (confirmed by grep), so nothing
   needed entering this period. See `bonus_data/README.md` for the full
   watch-item writeup -- when he does start showing up, he needs to be
   added to the Employees tab (department K) with either his ADP name
   set to "Pruitt, Thomas R" or a "Randy Pruitt" alias entry, the same
   way Jair Gomez 2 / Rachael Willcutt are merged today, or his hours
   will silently fall out of Kitchen Hours.

## Known issues deliberately left alone

- `bonus_data/` is untracked in git -- holding off on `git add`/commit
  until the Sales formula dispute (Open question 1) is settled, so a
  commit doesn't look like an endorsement of numbers under dispute.
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

- **Run a Preview (Finalize unchecked) test** of the new orders-CSV
  upload path on a real period before trusting it for a real Finalize --
  both halves are deployed now, this just hasn't been tried live yet.
- Waiting on Rod's review of the Sales formula (Open question 1) --
  top priority, real money involved.
- Resolve Open questions 2-3 with Rod as they come up.
- Decide whether to `git add`/commit `bonus_data/` (hold until Open
  question 1 is settled).
