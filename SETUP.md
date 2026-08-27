# GFG Tips — Setup Guide

This is Larry's tip-distribution input form, live on the web at
`tips.upshiftholdings.com`. It's a small app: Larry signs in, enters the
4-week tip numbers and driver day-counts, and submits. You can sign in too
and see every period that's ever been submitted. Nobody else can get in,
and Larry's account can't reach any other GFG data -- this is its own
separate Firebase project, holding nothing but tip submissions.

## Status so far

Done: Firebase project "GFG Tips" (Spark plan), web app registered,
Email/Password auth enabled, Firestore database created (production
mode), security rules deployed, your and Larry's user accounts created,
`roles/{uid}` documents created (admin for Rod, entry for Larry). All the
application files are here in this folder, with `firebase-config.js`
already filled in with your real project values.

Left to do: push this folder to GitHub, enable GitHub Pages with the
`tips` custom domain, and add the DNS record.

## Push to GitHub

1. Go to github.com and create a new **private** repository (e.g.
   `gfg-tips`). Do NOT initialize it with a README, .gitignore, or
   license -- leave it completely empty.
2. GitHub will show you a remote URL like
   `https://github.com/<you>/gfg-tips.git`.
3. From a terminal in this folder (`C:\Claude\tips`), run:
   ```
   git remote add origin https://github.com/<you>/gfg-tips.git
   git branch -M main
   git push -u origin main
   ```
   The first push will prompt you to sign into GitHub (browser popup or
   credential prompt) -- that's expected, sign in as yourself.

## Enable GitHub Pages with the custom domain

1. On the repo's GitHub page: Settings -> Pages.
2. Source: "Deploy from a branch" -> Branch: `main` -> `/ (root)` -> Save.
3. Under "Custom domain," enter `tips.upshiftholdings.com` and Save
   (this reads the `CNAME` file already in this folder).

## Point DNS at GitHub Pages

In whatever DNS provider manages `upshiftholdings.com`, add a CNAME
record:
- Host/name: `tips`
- Value/target: `<your-github-username>.github.io`

DNS can take minutes to hours to propagate. GitHub Pages auto-issues an
HTTPS certificate once it resolves (can take up to 24 hours) -- the site
works over the plain `github.io` URL immediately in the meantime.

## Test it

- Open the site, sign in as yourself -- you should see the form AND the
  admin "All periods" panel.
- Sign out, have Larry sign in -- he should see only the form, no admin
  panel, and should not be able to edit a period once he's submitted it.

## What's built vs. not

Built: sign-in, role-based access, live net-pool math, driver day-count
table, draft/submit states, admin all-periods list.

Not yet built: this form captures inputs only -- it doesn't calculate
each person's actual payout yet (the man-days pro-rata math), and
`timeclock_to_adp.py` doesn't read from Firestore yet. Both are planned
for when the next tips-paying period comes up.
