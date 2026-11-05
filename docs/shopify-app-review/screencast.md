# Shopify App Demo Screencast — Recording Guide

A short, focused screen recording that walks the reviewer through install → setup →
sync → result. Goal: prove the app works end-to-end and that every requested OAuth
scope is actually used. Keep it **2–4 minutes**, no fluff.

---

## Before you record (prep checklist)

- [ ] Use a **clean test store** with the app **not yet installed** (so you can show
      the real install/consent screen).
- [ ] Log into the Export Portal **beforehand in a separate tab** — but start the
      recording from logged-out so the login step is visible, OR pre-fill creds to
      keep it fast. (If creds are sensitive, blur them in edit.)
- [ ] Confirm the **"Patrik · Demo accessories"** source is configured and has a few
      products with images + prices, so the sync produces visible results.
- [ ] Have the **Shopify admin > Products** page ready in another tab for the
      "verify" shot.
- [ ] Close noisy tabs, notifications, Slack/email popups. Use a clean browser
      profile.
- [ ] Record at **1920×1080**, browser zoomed so text is readable (Ctrl/Cmd +).
- [ ] Move the mouse slowly and deliberately; pause ~1s on each button before clicking.

---

## Tools

- **Recording:** Loom, OBS Studio (free), ScreenStudio (auto zoom, polished), or
  macOS Screenshot (Cmd+Shift+5) / Windows Xbox Game Bar (Win+G).
- **Voiceover:** record live narration, or add captions in edit. Captions help —
  reviewers may watch muted.
- **Editing (optional):** trim dead time, add a 2–3s text caption per section,
  blur credentials. ScreenStudio or CapCut work well.

---

## Shot-by-shot script (~3 min)

**0:00 — Intro (10s)**
Caption: *"Export Portal — one-way product sync to Shopify."*
Say what it does in one line: pushes stock, products, prices and images from the
portal into Shopify; nothing is ever deleted.

**0:10 — Install & OAuth (40s)**
- Open the install link.
- Portal login page → sign in.
- App auto-connects → Shopify **install/consent screen** appears.
- Pause on the scopes list (reviewers want to see this), then click **Install**.
- Land back on the Integration page; green **"Store connected successfully."**
  banner + **"Active"** store pill.

**0:50 — Set up source & location (35s)**
- Scroll to **"Sources & locations"**.
- Pick **"Patrik · Demo accessories"** in the Source dropdown.
- Pick a **Shopify location**.

**1:25 — Configure (45s)**
- Click **Configure**.
- Show **"How much should we manage?"** → choose *"Create, then leave it to you"*.
- Show **"What to sync"** → enable Stock, New products, Prices.
- Show **Pricing** (VAT mode) and **Sales channels** briefly.
- Click **Save changes**.

**2:10 — Run the sync (25s)**
- Click **Sync now** → show **"Syncing…"** state.
- Show **Sync activity** counts (Synced/Pending/Error) updating; click a run row
  to show its detail.

**2:35 — Verify in Shopify (20s)**
- Switch to Shopify admin > **Products**.
- Show the pushed products with images/descriptions.
- Open one product → variants, **price**, and **inventory at the chosen location**.

**2:55 — Outro (5s)**
Caption: *"Automatic, one-way sync — your Shopify edits stay safe."*

---

## What reviewers specifically look for (cover these on camera)

- The **real OAuth consent screen** with the scopes — don't skip past it.
- **Each requested scope visibly used:** write_products (create), write_inventory
  (stock), price update, publications (sales channels). Your configure + sync shots
  cover these — narrate them.
- A **successful end-to-end result** in the Shopify admin, not just inside your app.
- **No deletions / non-destructive** behavior — say it out loud.

---

## Tips for a clean, submittable video

- One continuous take is fine; trim mistakes rather than re-recording everything.
- Don't show other merchants' data, internal tools, or anything outside this flow.
- Keep loading spinners short — trim long waits in edit, but don't fake results.
- End on the verified Shopify product page; that's the strongest closing frame.
- Export as **MP4, 1080p**. Host on Loom/YouTube (unlisted) or upload directly if
  the submission form allows.

---

## Common rejection causes this video should pre-empt

- "Couldn't verify the app works" → solved by the explicit verify-in-admin shot.
- "Scope not justified" → solved by narrating each scope as it's used.
- "Install flow unclear" → solved by showing the full link → login → consent →
  installed sequence without cuts.
