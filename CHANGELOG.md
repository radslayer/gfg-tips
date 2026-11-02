# GFG Payroll (tips repo) — Status & Changelog

Living status doc for this project. Maintained automatically by Claude at
natural stopping points (per Rod's standing instruction, set 2026-10-06) —
don't wait to be asked to update it. Sections are rewritten/condensed when
stale, not just appended to. A fresh Claude session should be able to read
this doc alone and pick up work without replaying prior conversations.

Last updated: 2026-11-02

## Current state / in progress

- **Kitchen Manager bonus formula — ROOT CAUSE FOUND AND FIXED
  11/2/2026, not yet deployed.** Rod asked directly (11/2) why Mike
  Gray's bonus/metric was so much higher than his own manual
  calculation, and which revenue columns were being summed. Answer:
  `SALES_COLUMNS` was `Subtotal + Gratuity + Discount + Setup +
  Delivery` -- Gratuity (tip money, not kitchen revenue) was being
  wrongly included, inflating Sales and therefore the Sales-per-
  Kitchen-Hour ratio and the resulting bonus. This is exactly the
  "unintended column" Rod's working theory (10/9) predicted. Confirmed
  by Rod 11/2: "they should not be included. Subtotal, Discount, Setup
  and Delivery. Those are the fields we should be capturing." Fixed in
  `functions/report_builder.py` (`SALES_COLUMNS`, the Sales Calc
  worksheet columns/docstrings), `bonus_data/compute_weekly_sales.py`
  (the standalone script this is ported from -- kept in sync), and
  `bonus_data/README.md`. Unit-verified: a synthetic 2-order test
  confirms Gratuity/Surcharge are excluded and the math matches by
  hand. **`weekly_metrics.csv` (and whatever's already in Firestore
  `weeklyBonusMetrics`) was computed with the OLD, Gratuity-inflated
  formula and has NOT been recomputed -- see the new "OPEN ITEM" at the
  top of `bonus_data/README.md`. Do not recompute/overwrite that
  history without Rod's explicit go-ahead, since it could revise
  amounts already paid out.** Not yet committed/deployed -- this
  period's payroll (pay date 11/6/2026) is confirmed unfinalized, so
  Rod asked to rerun it with this fix once deployed.

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

- **Pay period default now anchors to today's actual date
  (11/2/2026, per Guapo: "change this field so that it presents the
  next payroll date from the date it is requested... nearly every
  single time, if we're wanting to run the report on a Monday, it's
  for the following Friday's payroll.")** The top "Pay date" dropdown's
  auto-default (`pickDefaultPeriod` in `app.js`) used to scan
  `PAY_PERIOD_DATES` from the fixed display floor forward for the
  first one not yet marked `status: "submitted"` in Firestore
  `tipsPeriods` -- with no regard for today's real date. If any one
  period along the way was never explicitly marked submitted (skipped,
  or the status write failed/was forgotten), the dropdown would get
  stuck defaulting back to that stale old date indefinitely, no matter
  how far today had actually moved on. Fixed to anchor on today first:
  the earliest scheduled payroll date on or after today that hasn't
  been submitted, falling back to the old whole-list scan only if
  every upcoming date is somehow already submitted. Verified with a
  standalone Node repro of both the normal case (today Mon 11/2/2026 ->
  defaults to Fri 11/6/2026) and the stale-period bug case (an older
  unsubmitted period no longer traps the default). Also updated the
  helper text under the dropdown to match. Not yet committed/deployed.

- **New: a 1099 driver's Employee Purchases now reduce their 1099 payout
  (11/2/2026, per Guapo: "it is possible for a 1099 driver to make
  employee purchases. We need to create a mechanism to reduce their 1099
  payout by the amount of their employee purchase.")** Before this, the
  Employee Purchase dropdown on the Payroll Report tab only ever listed
  W2 `employees` -- a driver's name typed in some other way would have
  fallen into `unresolved_names`, warned every period, and never
  actually been deducted from anything; drivers had no path for this at
  all. Design confirmed with Guapo (three questions, all answered):
  (1) drivers are added to the SAME Employee Purchase dropdown (not a
  separate entry point), but ONLY for that request type -- PTO/Misc
  Amount/Misc Reimburse stay employees-only, since none of those apply
  to a 1099 contractor; (2) if a purchase is bigger than what the driver
  earned that period, this period's payout floors at $0 and a warning
  flags the shortfall for Guapo to collect directly -- no automatic
  carryover to the next period; (3) the purchase comes out of Tips +
  Deliveries $ Total + Setups $ Total together (not deliveries/setups
  only).
  - `app.js`: `populateEmployeeDropdown()` now also lists `DEFAULT_DRIVERS`
    (tagged "(driver)") whenever "Employee Purchase" is the selected
    request type, re-populated on every `reqType` change.
    `renderPendingAlerts()`'s "name isn't in the employee list" check no
    longer false-flags a driver's purchase request. The report-results
    preview table (`reportDriverRows`) and its header in `index.html`
    gained an "Employee Purchases" column, with Total now floored at $0
    after subtracting it (matches the workbook exactly).
  - `report_builder.py`: `build_report`'s purchase resolution is now a
    two-pass match -- first against `employees` (unchanged), then
    whatever's still unmatched gets a second pass against `driver_info`'s
    own keys (THIS period's real Tip Pool driver names, not a
    separately-maintained list that could drift -- see the Rod-dual-row
    bug fixed the same week for exactly what drift like that looks like).
    The Driver Payroll (1099s) Recap table on the "Contractors Payments"
    sheet gained an "Employee Purchases" column; "Total" is now
    `=MAX(0,Tips+Deliveries+Setups-EmployeePurchases)`. A driver whose
    purchases exceed their gross payout gets a dedicated warning naming
    the exact shortfall dollar amount. `summary["drivers"]` gained
    `eePurchases` for the live on-screen preview.
  - Verified with a real `build_report` call (synthetic CSV + driver_info
    + four pending-purchase records: one W2 employee, one driver within
    their gross payout, one driver EXCEEDING their gross payout, and one
    truly-unknown name) -- confirmed via `recalc.py` (0 formula errors,
    70 formulas) and a `data_only=True` read-back: the W2 purchase was
    unaffected, the in-budget driver purchase correctly reduced their
    Total (120 - 30 = 90), the over-budget driver purchase correctly
    floored their Total at $0 and produced the expected shortfall
    warning ($500 purchase - $10 gross = $490 shortfall), and the
    truly-unknown name still correctly fell through to the existing
    unresolved-name warning untouched.
  - **Caught in review (11/2/2026, per Guapo asking "did you also modify
    the output for the driver so that they can see the deduction"):**
    the actual per-driver "Driver Payment Advice" PDF
    (`functions/driver_advice_pdf.py`, auto-generated on finalize and
    pushed straight to the OneDrive folder drivers pull from -- see
    `get_driver_advice_pdfs`/`DRIVERS_FOLDER` in main.py) had NOT been
    touched -- it only ever took tips/deliveries/setups, so a driver's
    own copy would have shown their full gross amount with no sign of
    the deduction at all, contradicting what they're actually paid.
    Fixed: `build_driver_advice_pdf` takes a new `ee_purchases` param,
    shows an "Employee Purchases" line (only when nonzero, so a driver
    with no purchase sees the exact same 3-line layout as always) and
    floors Total at $0 the same way the sheet does. The "skip -- nothing
    to report" check in main.py now also counts a purchase on file as
    "something to report," so a driver with a deduction but otherwise
    quiet period still gets an advice instead of none at all. Verified
    by generating and reading back three real PDFs via pdftotext: no
    purchase (unchanged), a $30 purchase against $140 gross (Total
    $110.00), and a $500 purchase against $10 gross (Total floored at
    $0.00) -- all correct.
  - **Resolved (11/2/2026, per Guapo): "you can generate the report and
    show a negative balance with an explanation of why. You should
    itemize the employee purchases if there are more than one on this
    report, rather than aggregating them."** Two changes:
    1. Total is no longer floored at $0 anywhere it's shown -- the
       Contractors Payments sheet's formula, the Driver Payment Advice
       PDF, and the live on-screen report preview (`app.js` -- also fixed
       `money()`'s negative formatting, which rendered the ugly
       "$-490.00" instead of "-$490.00") all now show the real negative
       number when purchases exceed earnings. The shortfall warning text
       was updated to match ("their payout this period shows as
       -$490.00" instead of "their 1099 payout is $0"). No automatic
       carryover to the next period either way -- that part of the
       original decision still stands.
    2. The Driver Payment Advice PDF itemizes -- `report_builder.py` now
       keeps each individual purchase record (not just the summed total)
       per driver as `eePurchaseItems` in the summary, threaded through
       `main.py` to `driver_advice_pdf.build_driver_advice_pdf`, which
       shows one line per purchase (product + date) when a driver has
       MORE than one that period, or the original single combined line
       when there's zero or one (unchanged from before). When Total goes
       negative, a plain-language note appears right under the recap
       table -- "Employee Purchases this period exceeded total earnings
       by $X.XX." -- deliberately without saying how/when it'll be
       collected, since that's a conversation between Guapo and the
       driver, not something to presume in an auto-distributed PDF. The
       Contractors Payments sheet itself still shows one aggregated
       Employee Purchases column per driver (a summary table across all
       drivers, not a per-driver statement) -- only the PDF itemizes,
       since that's the document this was actually asked about.
    - Verified for real: regenerated the same two synthetic PDFs with
      `recalc.py` confirming 0 formula errors on the sheet (Ross Pullen's
      row correctly reads 10 - 500 = -490, Totals row -400) and
      `pdftotext` confirming Richard Haselton's PDF lists "Employee
      Purchase - Gatorade (11/5/2026) -$10.00" and "...- Phone Mount
      (11/9/2026) -$20.00" as separate lines (Total $90.00), while Ross
      Pullen's single purchase still renders as one "Employee Purchases
      -$500.00" line, Total -$490.00, with the exceeded-earnings note
      printed directly beneath it.
  - **Not yet committed, pushed, or deployed** -- this is a real
    behavior/money change (deducts from a contractor's payout), so it's
    held for Guapo's review before going live, unlike the smaller fixes
    earlier this week.

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
