# SitePulse — Landing Page

Standalone marketing/landing site for **SitePulse** (SIH 2026, Problem Statement
**SIH26122**, Oil India Limited).

A standalone Next.js app: the marketing page plus a full authentication
system. Self-contained — no external backend.

## Running it

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

```bash
npm run build && npm start   # production
```

## Stack

- **Next.js 16** (App Router) + **React 19** + **TypeScript**
- **Tailwind v4** — tokens only, no config file, no component library
- **Zero animation dependencies** — CSS keyframes plus one `IntersectionObserver`

## Design system

An industrial/engineering palette — off-white paper, near-black ink, teal
accent — with rust and amber reserved for warning and review states:

| Token | Light | Dark |
| --- | --- | --- |
| `paper` / `paper-raised` / `paper-sunk` | `#edf0ec` / `#ffffff` / `#e4e8e2` | `#10161a` / `#182024` / `#0b1013` |
| `ink` / `ink-soft` | `#141c22` / `#55636b` | `#e8ece9` / `#9aa8a4` |
| `accent` / `accent-strong` / `accent-soft` | `#2d6e68` / `#1d4a46` / `#e2eeec` | `#5fb3ab` / `#8fd0c8` / `#1c2e2c` |
| `on-accent` † | `#ffffff` | `#0d1215` |
| `rust` / `amber` | `#a35630` / `#7d6119` ‡ | `#d68a63` / `#d6b85f` |

Type: **Big Shoulders** (display), **Public Sans** (body), **IBM Plex Mono** (mono).

### Light / dark

Three states, cycled by the header toggle: **system → light → dark → system**.

- Palette values are declared once as `--l-*` / `--d-*` pairs, then *mapped* onto
  the live token names by three small blocks. The two schemes can't drift apart,
  because neither one owns a copy of the values.
- "System" stores nothing and follows `prefers-color-scheme`. Light and dark set
  `data-theme` on `<html>` and persist to `localStorage` under `sitepulse-theme`.
- An inline script in `layout.tsx` applies the stored choice **before first
  paint**, so a pinned theme never flashes the other one.
- `color-scheme` is set alongside each mapping so scrollbars and form controls
  match.

### Two tokens that came out of the contrast audit

- **† `--on-accent`.** `--accent` inverts between schemes (dark teal on light,
  light teal on dark), so a fixed white button label measures **2.46:1** in dark
  mode. `--on-accent` flips with the scheme — 7.4:1 dark, 5.9:1 light. Use it for
  anything sitting on `--accent`; never hardcode `#fff` there.
- **‡ light `--amber` is `#7d6119`.** The review-state readouts are ~11px on
  `--paper`, where a lighter amber lands just under AA. This reads 5.0:1.

Audited by compositing real rendered pixels (Tailwind v4 emits `oklab()` with
alpha, so parsing `getComputedStyle().color` as rgb gives wrong numbers), sampled
across the full hero animation cycle in both schemes. Both report zero failures
against AA at 375px and at desktop width.

> Auditing gotcha: measure each scheme on a **fresh page load**, not by flipping
> `data-theme` at runtime. Elements carrying `transition-colors` are mid-transition
> when you read them, so they report the *previous* scheme's color and look like
> false failures. The same applies to reading layout mid-resize.

## Mobile

- Header collapses to logo + theme toggle + hamburger. The sheet holds the four
  section links, the CTA and the source link; it locks body scroll, closes on
  Escape, on link tap, and on resize past `md`.
- Every interactive target is **≥44px** (menu rows are 48px). Verified at 375px:
  zero undersized targets, zero horizontal overflow.
- The hero trust strip is a 2-column grid on phones — plain `flex-wrap` left an
  orphaned last item. The eyebrow drops "· Oil India Limited" below `sm` so it
  stays on one line.
- Section rhythm tightens on small screens (`py-16` → `sm:py-20` → `lg:py-28`),
  and display sizes step down rather than scaling one value.

## Gotcha: custom classes and Tailwind layers

`.btn`, `.menu-link` and friends live inside `@layer components`. Left unlayered
they beat every utility — an unlayered `.btn { display: inline-flex }` silently
overrode `hidden`, which kept the header CTA visible (and wrapping) on mobile.

## Structure

```
src/
  app/
    layout.tsx      fonts, metadata, no-JS reveal fallback
    globals.css     DS tokens + the motion layer
    page.tsx        the whole page: hero → problem → how → people → trust → CTA → footer
  components/
    site-header.tsx    sticky nav, transparent until scrolled
    hero-transform.tsx the animated message → linked-update showpiece
    pipeline.tsx       six-stage schematic, lights up in sequence on scroll
    reveal.tsx         IntersectionObserver scroll-reveal wrapper
    icons.tsx          inline SVG set
```

## Content accuracy

Numbers on the page are the real ones from the product: confidence weights
(0.50 / 0.20 / 0.15 / 0.15), the bounded ±0.15 correction nudge, the four
matcher outcomes, the single global SHA-256 audit chain, and the three separate
risk flags. Keep them in sync if the matcher changes.

The footer carries an explicit "not affiliated with Oil India Limited"
disclaimer — leave it in.

## Authentication

Email + password, phone OTP, email OTP, and Google sign-in. **No auth library and
no database dependency** — `node:sqlite`, `node:crypto` and Server Actions cover
all of it. The only package added is `server-only`, a build-time guard.

### Flow

    landing ──> Get started ──> signup ──> email OTP ──> phone OTP ──> /dashboard
            └─> Sign in ─────> login  ──┬────────────────────────────> /dashboard
                                        └─> Google ──> phone OTP ────> /dashboard
    forgot ──> emailed link ──> reset ──> login

`/login`, `/signup`, `/verify`, `/forgot`, `/reset`, `/dashboard`.

The header is session-aware: **Sign in / Get started** when signed out,
**Dashboard** when signed in. `/login` and `/signup` redirect to `/dashboard` for
an already-authenticated visitor, and `/dashboard` redirects to `/login` without
a session — so no route ever shows the wrong state. Reading the session makes `/`
a dynamic route; the alternative was a client-side session fetch and a flash of
the wrong nav.

### Where the security actually sits

| Concern | How |
| --- | --- |
| Password storage | scrypt N=65536 r=8 p=1, 32-byte per-hash salt, `timingSafeEqual` |
| Password policy | Length only (8–200). **`12345678` is accepted** — NIST 800-63B says no composition rules. The meter advises, it does not block. |
| Sessions | Opaque 256-bit token in an **httpOnly, SameSite=Lax, Secure-in-prod** cookie. Only its SHA-256 is stored, so a dumped table yields no usable cookie. Nothing in `localStorage`. |
| Session lifetime | 7-day absolute cap + 24-hour idle cutoff, both checked server-side on every read |
| Authorization | Every page re-reads the session server-side. No middleware gate (CVE-2025-29927 made that a poor single line of defence) |
| CSRF | Next compares `Origin` to `Host` on every Server Action, plus SameSite=Lax. Verified: a foreign-origin POST is aborted before dispatch. |
| OTP | 6 digits from `randomInt`, stored as **HMAC-SHA256 keyed with `AUTH_SECRET`** so a dumped DB can't be brute-forced offline. 10-min expiry, 5-attempt cap, single use. |
| SQL injection | Prepared statements with bound parameters throughout; no string-built SQL anywhere |
| XSS | React escaping; the only `dangerouslySetInnerHTML` is the static theme script with no user input |
| IDOR | Identity always comes from the session. The verified phone number is read from the OTP record, never from the submitted form. |
| Enumeration | Login and reset return one generic message; a miss still burns a scrypt hash so timing matches. Signup against a verified address sends "you already have an account" and issues a cookie pointing at nothing — same screens, no session possible. |
| Rate limiting | SQLite-backed fixed windows: login 8/15min per account + 20/15min per IP, signup 5/h, OTP send 3/10min, reset 3/h |
| Secrets | `.env.local`, gitignored. `publicUser()` is the only shape sent to the client and carries no hash or provider id. |
| Headers | `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, CSP `frame-ancestors/base-uri/form-action/object-src`, `poweredByHeader: false` |

### Two holes found while auditing this, and fixed

- **Google pre-hijacking.** An attacker registers the victim's address with a
  password and never verifies it; the victim later signs in with Google, and the
  attacker's password is still live on the now-verified account. Claiming an
  address via Google now discards any password on a never-verified row and drops
  its sessions. Test: *"claiming a never-verified address via Google discards the
  squatter's password"*.
- **Phone-number squatting.** Signing up against an existing *unverified* account
  overwrote its `pending_phone`, leaving the real owner staring at a number they
  never chose and no way to change it. The phone step now always offers
  "Not your number?".

### Known limits

- **`script-src` is not in the CSP.** Next injects inline bootstrap scripts, so a
  strict policy needs a per-request nonce from middleware. The four directives
  that are set block clickjacking, `<base>` injection, form exfiltration and
  plugin content with zero breakage.
- **`x-forwarded-for` is spoofable** unless a trusted proxy overwrites it. Every
  IP limit is therefore paired with a per-account limit that spoofing can't dodge.
- **No cleanup job** for expired sessions/OTPs/resets. They're rejected on read;
  the rows just accumulate.
- **`__Host-` cookie prefix unused** — it requires HTTPS, which localhost isn't.
- **SMS is not free anywhere.** Codes print to the server log unless a provider
  key is set. Verified the hard way: **Fast2SMS free credits do not cover the
  API** — it answers `status_code 999, "You need to complete one transaction of
  100 INR or more before using API route."` India also requires DLT registration
  for A2P SMS, which is why every Indian provider gates this. Email *is* free —
  `RESEND_API_KEY`, 3k/month.
- **A refused SMS falls back to the console in dev.** Fast2SMS answers HTTP 200
  even when it rejects a message, so the response body is parsed for
  `return === true`. On refusal the code is logged instead, because it is already
  stored and the user would otherwise be stuck on a step they cannot pass.
  Production never logs a live code.

### Setup

```bash
cp .env.example .env.local
npm run gen-secret     # paste AUTH_SECRET into .env.local
npm run dev
npm test               # 208 tests across auth, access, people, hardening and schedule
```

Google sign-in is optional; the button only renders when `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` are set. Redirect URI:
`http://localhost:3000/api/auth/google/callback`.
Delete `.data/` to reset all accounts.

## Phone verification is optional (for now)

`REQUIRE_PHONE_VERIFICATION=false` in `.env.local`. Email is still mandatory;
phone is offered on the dashboard as "Verify by OTP" but nobody is blocked.

**To make it mandatory on demo day:** flip that flag to `true`. That's the only
change. If a working `FAST2SMS_API_KEY` / `TWILIO_*` is also present the code
goes by SMS; without one it appears on the verify page itself (dev only), so the
flow still demos end to end.

The whole OTP mechanism is live either way — generation, HMAC-keyed storage,
10-minute expiry, 5-attempt cap, single use, rate limiting. Only the carrier hop
is deferred.

> Fast2SMS route reality, verified against a live account: `q` (Quick SMS) needs
> no DLT but is locked until the account makes one ₹100 transaction, and bills
> ~₹5/SMS after. `otp` and `dlt` are cheaper but both require DLT registration
> (Entity ID + approved Sender ID + approved template), which takes days.

## Projects and team hierarchy

`/dashboard`. **Reporting lines belong to a project, not to a person** — the same
crew member sits under one supervisor here and a different one elsewhere.

That drove the data model into three tables:

| Table | Holds | Why |
| --- | --- | --- |
| `people` | name, phone, email, discipline | Identity. One row per person per account, however many projects they're on. |
| `projects` | name, code | Scoped to an owner; names unique per owner. |
| `memberships` | `parent_person_id`, `role` | Placement. One row per person per project — this is where the tree lives. |

So a phone number is stored once, but the chain is per-project. Role sits on the
membership too, because someone is "Helper" on one job and "Senior Technician"
on another.

Adding someone who's already on the roster reuses them — matched on **phone
first, then exact name** — so their details carry over and only the reporting
line is new. Removing them from a project leaves the person and their other
placements alone.

### Changing a supervisor

Every row has a **Move** control, at any depth — the account holder can re-parent
anyone, not just direct reports.

**This is what made cycles reachable**, and a cycle is worse than an error: put
someone under their own report and neither becomes a root, so `buildTree` would
drop that entire branch and the people would silently vanish. Three defences:

1. The picker excludes the person and everyone below them, so a loop can't be
   selected. Verified live: a manager with one report is offered only "top level".
2. `setManager` re-checks server-side — self, descendant, and depth-cap moves are
   all refused with a message.
3. `buildTree` surfaces anyone stranded by a cycle at the top rather than
   dropping them, so even a bug can't make people disappear.

The picker renders only for the row being moved. At the 500-person cap, a select
on every row would be a quarter of a million `<option>` nodes.

### Migration

Pre-projects, the reporting line lived on `people.parent_id`. `migrateToProjects`
lifts each owner's existing team into a project called "First project" and moves
`parent_id`/`role` onto memberships. Idempotent — it only runs while an owner has
people with no membership. The legacy columns are left in place, unused.

### Constraints

| Rule | Reason |
| --- | --- |
| Every query scoped by `owner_id` | The IDOR defence. A project id from the URL, and a parent id from a form, are both only trusted after an owner-scoped lookup. |
| 500 people per project, 10 levels, 40 projects | One paste can't blow up the table or build a pathological tree. |
| 512KB upload cap | Server Action bodies default to 1MB. |
| `.xlsx` read without a dependency | `src/lib/xlsx.ts` unzips the workbook with `node:zlib` and parses the sheet XML — 163 lines, versus a dependency for one function. A corrupt file is reported, never thrown. |

CSV import is per-project and resolves `reports to` by name within that project.
Covered by tests along with cross-tenant read/add/move/delete attempts, cycle
attempts at both depths, the depth cap, and SQL/XSS payloads round-tripping as
literal text.

## Foundation hardening

Everything below was added after an audit of the schema, the assignment paths and
the import flow. The architecture did not change; the guarantees did.

### Transactions

`tx()` in `lib/db.ts` wraps a multi-statement mutation in `BEGIN IMMEDIATE`, and
uses a `SAVEPOINT` when one is already open — so an import can wrap a 653-row
batch while each row still runs through the same `createTask` a form submission
uses. Every mutation that touches more than one table now goes through it:
create, update, assign, delegate, delete, remove-a-member, re-parent, and both
importers. A failure part-way leaves nothing behind.

### Guards in the database, not only in the code

SQLite cannot add a foreign key to an existing table without a full rebuild, and
the rules here are cross-column anyway — a manager must be on the *same project*,
which no FK to `people(id)` can express. So they are triggers:

| Guard | Refuses |
| --- | --- |
| `trg_membership_parent_*` | a manager who isn't on the same project, and self-parenting |
| `trg_task_assignee_*` | assigning a task to someone not on its project |
| `trg_task_progress_*` | progress outside 0–100 |
| `idx_tasks_ref` (unique) | two tasks sharing a ref within a project |

The application still returns friendly messages first; these are the backstop for
a bug, a future call site, or someone at the `sqlite3` prompt.

### The assignment chain

`task_assignments` is append-only by construction — nothing in `lib/tasks.ts`
UPDATEs or DELETEs a row in it. Each entry carries `parent_assignment_id`, so
`L1 → L2 → L3 → L4` survives intact:

| Column | Answers |
| --- | --- |
| `assigned_to` / `assigned_by` | who holds it, who moved it |
| `parent_assignment_id` | what it was before |
| `assignment_type` | initial / reassigned / delegated / unassigned |
| `source` | manual / auto / delegation — **`auto` marks an assignee the importer worked out**, so "which of these did the system decide?" stays answerable |
| `created_at` | when |

`assignmentSummary()` reads the original assignee, the current one, the number of
delegations and the full chain off it. Two bugs fixed here: re-saving the same
assignee is refused rather than padding the chain with a no-op, and unassigning
then reassigning no longer writes a second `initial` — a chain has exactly one
beginning.

Every automatic assignment stays editable. That is asserted by a test.

### Refs

Task refs came from `count(*) + 1`, which reuses a number the moment a task is
deleted and collides with the ref an older row still holds. The counter now lives
on `projects.task_seq`, only goes up, and the migration seeds it past whatever
already exists, nulls the older duplicates, and adds the unique index.

### Imports

- **Transactional.** A throw on row 400 of 653 used to leave 399 written. Now the batch lands whole or not at all, and the message says so.
- **Duplicates.** A repeated task id inside the file, or one already in the project, is an error row. A repeated *name* with no id is a warning — the same activity legitimately recurs across a WBS.
- **Malformed files.** `staging.load()` catches the ZIP reader, so start, refine and commit all degrade to the same message instead of throwing an unhandled Server Action error at whichever step hit it.
- **Reporting.** The result says how many were auto-assigned, how many were left unassigned, and why each row was skipped — deduplicated and counted.

### Auditability

`task_events` carries every kind in `EVENT_KINDS`: created, updated, deleted,
imported, assigned, reassigned, unassigned, delegated, status_changed,
progress_changed, person_added, person_moved, person_removed, role_changed.
Status and progress get their own events rather than folding into "updated".

`task_events.task_id` deliberately has no foreign key, so the record that a task
existed outlives the task itself.

### Leavers

Removing someone from a project used to leave their tasks pointing at a
non-member — an assignee the UI rendered as blank. Removal now releases their
tasks back to the pool first, appending an `unassigned` entry that says why, and
the action reports how many moved. Names in the history resolve from the roster
rather than the member list, so a departed person is still named in every past
entry instead of degrading to "someone".

### Permissions

Unchanged in shape, which was already right: **role carries permissions,
hierarchy carries scope**, and depth grants nothing by itself. Tests assert that
an L2 with a Viewer role cannot do what an L4 with a Manager role can, and that a
custom role with no preset behind it is honoured.

Fixed alongside: `editTask` had no rate limit, and `setTaskStatus` / `removeTask`
/ `removeTeamMember` returned `void` — swallowing every refusal, so a contributor
nudging someone else's task saw the control snap back with no explanation. All
three now return state and the UI renders it.

## Schedule activities

`/dashboard/schedule`. An **activity** is a line of a real project schedule — a
P6 or MS Project row with an Activity ID, a WBS position, planned and baseline
dates and logic links.

### Where it lives, and why there is no `activities` table

Activities are stored in `tasks`, extended in place. `task_assignments` and
`task_events` already key off `tasks.id`, and the append-only assignment chain,
its guard triggers and its indexes all hang off that. A parallel table would
have meant either duplicating that machinery or rebuilding the foreign keys —
for a row that was already a degenerate activity. The schedule columns are
purely additive; the domain language lives in `lib/schedule.ts`.

Two column mappings worth knowing:

- **`ref` is the Activity ID.** It already had the right semantics — the file's
  own identifier, unique per project — and a second column would need its own
  unique index and start drifting from this one immediately.
- **`start_date` / `due_date` are the planned start / planned finish.**

### Five things, kept apart

| Concern | Table | Holds |
| --- | --- | --- |
| Activity | `tasks` | what the schedule says should happen |
| Assignment | `task_assignments` | who is responsible, and every hand-off |
| Progress event | `progress_events` | what the field *claims* happened |
| Evidence | `evidence` | the proof offered for a claim |
| Audit event | `task_events` | what actually changed |

A progress event is deliberately **not** an update to the activity. It is a
claim: it may be wrong, it may match no activity at all, and it has to survive
review either way. Applying one is a separate, audited step inside the same
transaction that marks it applied — so a report can never read as accepted while
the activity it referred to was left untouched.

`activity_relations` holds the logic. One row per edge, so successors are the
rows where you are the predecessor and the two directions cannot disagree. A
dependency that would close a loop is refused at creation, and the database
refuses an edge that leaves the project.

### Import

Handles a P6 or MS Project export as-is. Activity ID, name, WBS code and path,
discipline, location, planned/baseline/actual dates, duration, predecessors,
successors, progress, status and assignee are all recognised, with aliases drawn
from what those tools actually write. Nothing is required beyond a name (new
schedule) or an Activity ID (update).

Two modes, because a schedule is re-issued weekly:

- **New schedule** — every row is new. An Activity ID already present is refused,
  and the message names the fix.
- **Update existing** — rows matching an Activity ID refresh in place; anything
  new is added. Assignment changes go through the same append-only chain a
  manual reassignment does.

**Only the columns a file actually carries are written.** Found the hard way in
the live app: a progress-only re-issue blanked WBS, discipline, location and the
baseline on every row it touched. A mapped-but-blank cell still clears the field
— that is an explicit instruction — but an absent column is not.

The commit is one transaction across three passes: rows, then logic resolved
against the whole project (so a link into last week's import still connects),
then the import record. A predecessor naming an activity that isn't there is
reported, never invented.

### Gotcha: the WBS code and the WBS path disagree

`1.3` with the path `Duliajan > Piping > Testing` is two levels of code and
three of name, and real exports are full of this. Front-aligned segments name
the summary levels correctly; the last segment names the leaf. Missing summary
levels are synthesised, because a file that jumps from `1` to `1.2.1` still
needs a `1.2` to hang the branch under.

### Prepared for the matcher, not implemented

`activity_embeddings` stores one vector per activity as Float32 bytes, keyed by
a hash of the text it was built from — so a schedule of 5000 where two titles
changed re-embeds two, not 5000. `matchTextFor()` is the single definition of
what an activity is matched on. `progress_events` already carries `confidence`,
`match_method` and the review states.

Nothing embeds or matches yet. These are the seams, not the feature.

### Gotcha: the legacy migration resurrected removed people

`migrateToProjects` looked for "people with no membership" and lifted them into
a project. That was true of pre-projects data — and equally true of anyone
legitimately removed from every project, who came back as a member on the next
boot. Caught in the live database. It is now gated on a one-time marker in a
`meta` table rather than on the shape of the data.
