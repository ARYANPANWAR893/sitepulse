import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Dev hot-reload re-evaluates modules; without this we'd leak a handle per reload.
const g = globalThis as unknown as { __authDb?: DatabaseSync };

const FILE = process.env.AUTH_DB_PATH ?? ".data/auth.db";

function open(): DatabaseSync {
  mkdirSync(dirname(FILE), { recursive: true });
  const db = new DatabaseSync(FILE);
  // Build workers and the dev server can open this file concurrently; without a
  // busy timeout the first writer wins and the rest throw SQLITE_BUSY.
  db.exec("PRAGMA busy_timeout = 5000");
  try { db.exec("PRAGMA journal_mode = WAL"); } catch { /* already WAL */ }
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      email          TEXT NOT NULL UNIQUE,
      phone          TEXT UNIQUE,
      pending_phone  TEXT,
      password_hash  TEXT,
      email_verified INTEGER NOT NULL DEFAULT 0,
      phone_verified INTEGER NOT NULL DEFAULT 0,
      google_sub     TEXT UNIQUE,
      role           TEXT NOT NULL DEFAULT 'operator',
      created_at     INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS otps (
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel    TEXT NOT NULL,
      target     TEXT NOT NULL,
      code_hash  TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, channel)
    );
    CREATE TABLE IF NOT EXISTS resets (
      token_hash TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS rate (
      k        TEXT PRIMARY KEY,
      count    INTEGER NOT NULL,
      reset_at INTEGER NOT NULL
    );
    -- Identity. One row per person on the account, regardless of how many
    -- projects they appear in.
    CREATE TABLE IF NOT EXISTS people (
      id         TEXT PRIMARY KEY,
      owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      parent_id  TEXT,                       -- legacy, pre-projects; unused
      name       TEXT NOT NULL,
      phone      TEXT,
      email      TEXT,
      role       TEXT,                       -- legacy, pre-projects; unused
      discipline TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id         TEXT PRIMARY KEY,
      owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      code       TEXT,
      created_at INTEGER NOT NULL
    );

    -- Placement. The reporting line lives here, not on the person, because the
    -- same person sits under different managers on different projects.
    CREATE TABLE IF NOT EXISTS memberships (
      project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      person_id        TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      parent_person_id TEXT,                 -- another person in this project; NULL = reports to the account holder
      role             TEXT,
      created_at       INTEGER NOT NULL,
      PRIMARY KEY (project_id, person_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_people_owner ON people(owner_id);
    -- Roles carry permissions; hierarchy carries scope. Deliberately separate,
    -- so a "Manager" can sit at any depth and depth grants nothing by itself.
    CREATE TABLE IF NOT EXISTS roles (
      id          TEXT PRIMARY KEY,
      owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      description TEXT,
      permissions TEXT NOT NULL,            -- JSON array of permission keys
      scope       TEXT NOT NULL,            -- self | direct | subtree
      preset      INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      description TEXT,
      status      TEXT NOT NULL DEFAULT 'not_started',
      priority    TEXT NOT NULL DEFAULT 'medium',
      start_date  TEXT,
      due_date    TEXT,
      assigned_to TEXT REFERENCES people(id) ON DELETE SET NULL,
      assigned_by TEXT REFERENCES people(id) ON DELETE SET NULL,
      created_by  TEXT REFERENCES people(id) ON DELETE SET NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    -- Every assignment ever made on a task, newest last. The task row carries
    -- the *current* owner; this carries how it got there. Delegation appends
    -- rather than overwrites, so the chain L1 → L2 → L3 → L4 survives.
    CREATE TABLE IF NOT EXISTS task_assignments (
      id                   TEXT PRIMARY KEY,
      task_id              TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      assigned_to          TEXT REFERENCES people(id) ON DELETE SET NULL,
      assigned_by          TEXT,          -- person id; NULL means the project owner
      parent_assignment_id TEXT REFERENCES task_assignments(id) ON DELETE SET NULL,
      assignment_type      TEXT NOT NULL, -- initial | delegated | reassigned | unassigned
      created_at           INTEGER NOT NULL
    );

    -- An upload parked between "choose a file" and "import". Keeps the file
    -- server-side so the mapping and preview steps never round-trip megabytes
    -- through the browser, and so nothing can be swapped in between steps.
    CREATE TABLE IF NOT EXISTS import_staging (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL,
      kind       TEXT NOT NULL,          -- tasks | people
      filename   TEXT,
      content    TEXT NOT NULL,          -- base64 when binary, raw text otherwise
      is_binary  INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    -- Lightweight activity feed for the dashboard. Not an audit log.
    CREATE TABLE IF NOT EXISTS task_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id    TEXT,
      kind       TEXT NOT NULL,             -- created | assigned | reassigned | updated
      actor      TEXT,                      -- person id, or NULL for the account owner
      detail     TEXT,
      at         INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_owner_name ON projects(owner_id, name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_owner_name ON roles(owner_id, name);
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assigned_to);
    CREATE INDEX IF NOT EXISTS idx_events_project ON task_events(project_id, at);
    CREATE INDEX IF NOT EXISTS idx_assign_task ON task_assignments(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_memberships_project ON memberships(project_id);
    CREATE INDEX IF NOT EXISTS idx_memberships_parent ON memberships(parent_person_id);
  `);
  // Next builds with several worker processes, each opening this file. Without
  // an exclusive lock one worker can be midway through ALTER TABLE while
  // another prepares a statement naming the new column — which surfaces as
  // "SQL logic error" on the very first boot after a schema change. Taking
  // BEGIN IMMEDIATE makes the losers wait (busy_timeout) and then observe the
  // finished schema before they prepare anything.
  db.exec("BEGIN IMMEDIATE");
  try {
    migrateToProjects(db);
    // Columns added after the first release; each ALTER is guarded, so this is
    // idempotent however many times it runs.
    addColumn(db, "people", "user_id", "TEXT");          // links a person to a login account
    addColumn(db, "memberships", "role_id", "TEXT");     // role is per-project
    addColumn(db, "projects", "description", "TEXT");
    addColumn(db, "projects", "location", "TEXT");
    addColumn(db, "projects", "start_date", "TEXT");
    addColumn(db, "projects", "client", "TEXT");
    addColumn(db, "projects", "planned_completion", "TEXT");
    addColumn(db, "tasks", "ref", "TEXT");                    // human-readable id, e.g. RGP-014
    addColumn(db, "memberships", "hierarchy_level", "INTEGER"); // derived from reports-to, stored for query
    addColumn(db, "tasks", "progress", "INTEGER NOT NULL DEFAULT 0");  // 0-100
    // How an assignment came about, kept apart from what kind it was. A row can
    // be assignment_type 'initial' from an import and 'initial' from the New
    // Task form; only this tells them apart afterwards.
    addColumn(db, "task_assignments", "source", "TEXT");
    // Sequence high-water mark. Refs used to be derived from count(*), so
    // deleting a task made the next one collide with an existing ref.
    addColumn(db, "projects", "task_seq", "INTEGER NOT NULL DEFAULT 0");
    // --- schedule activities ------------------------------------------------
    //
    // The `tasks` table IS the schedule activity table. It was not renamed and
    // no parallel `activities` table was created, deliberately:
    // `task_assignments` and `task_events` already key off `tasks.id`, and the
    // assignment/delegation chain, its guard triggers and its indexes all hang
    // off that. A second table would mean either duplicating that machinery or
    // rebuilding the foreign keys — for a row that is already a degenerate
    // activity (name, dates, status, assignee). The schedule fields are purely
    // additive; the domain language lives in lib/schedule.ts.
    //
    // `ref` carries the Activity ID. It already had the right semantics — the
    // file's own identifier, unique per project — and a second column would
    // need its own unique index and immediately start drifting from this one.
    // `start_date` / `due_date` are the planned start / planned finish.
    addColumn(db, "tasks", "wbs", "TEXT");                 // "1.2.3"
    addColumn(db, "tasks", "wbs_path", "TEXT");            // "Unit 3 > Piping > Spooling"
    addColumn(db, "tasks", "wbs_level", "INTEGER");        // derived from the code's depth
    addColumn(db, "tasks", "discipline", "TEXT");
    addColumn(db, "tasks", "location", "TEXT");
    addColumn(db, "tasks", "baseline_start", "TEXT");
    addColumn(db, "tasks", "baseline_finish", "TEXT");
    addColumn(db, "tasks", "actual_start", "TEXT");
    addColumn(db, "tasks", "actual_finish", "TEXT");
    addColumn(db, "tasks", "planned_duration", "INTEGER"); // days
    addColumn(db, "tasks", "actual_duration", "INTEGER");
    addColumn(db, "tasks", "notes", "TEXT");
    addColumn(db, "tasks", "origin", "TEXT");              // manual | import
    addColumn(db, "tasks", "import_id", "TEXT");           // the import that last wrote this row
    backfillTaskSeq(db);
    dedupeTaskRefs(db);
    repairHierarchy(db);
    installScheduleTables(db);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_ref ON tasks(project_id, ref) WHERE ref IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_assign_to ON task_assignments(assigned_to);
      CREATE INDEX IF NOT EXISTS idx_assign_by ON task_assignments(assigned_by);
      CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id);
      CREATE INDEX IF NOT EXISTS idx_people_user ON people(user_id);
    `);
    installGuards(db);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return db;
}

/**
 * Ref sequence used to be `count(*) + 1`, which reuses a number as soon as a
 * task is deleted and collides with the ref still held by an older row. The
 * counter now lives on the project and only ever goes up; seed it past whatever
 * the existing refs already used.
 */
function backfillTaskSeq(db: DatabaseSync): void {
  const rows = db.prepare(`
    SELECT p.id AS id, p.task_seq AS seq, count(t.id) AS n
    FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
    GROUP BY p.id
  `).all() as { id: string; seq: number; n: number }[];
  const set = db.prepare("UPDATE projects SET task_seq = ? WHERE id = ?");
  for (const r of rows) if (r.seq < r.n) set.run(r.n, r.id);
}

/**
 * A unique index can't be created while duplicates exist, and the count(*)
 * sequence above means older databases may hold some. Keep the oldest row's ref
 * and null the rest — a null ref renders as "—" rather than lying about identity.
 */
function dedupeTaskRefs(db: DatabaseSync): void {
  db.exec(`
    UPDATE tasks SET ref = NULL WHERE id IN (
      SELECT id FROM (
        SELECT id, row_number() OVER (PARTITION BY project_id, ref ORDER BY created_at, rowid) AS rn
        FROM tasks WHERE ref IS NOT NULL
      ) WHERE rn > 1
    )
  `);
}

/**
 * SQLite can't add a foreign key to an existing table without a full rebuild, so
 * `memberships.parent_person_id` never had one. Clear anything already dangling
 * before the guard triggers below start rejecting it.
 */
function repairHierarchy(db: DatabaseSync): void {
  db.exec(`
    UPDATE memberships SET parent_person_id = NULL
    WHERE parent_person_id IS NOT NULL AND (
      parent_person_id = person_id
      OR NOT EXISTS (
        SELECT 1 FROM memberships m
        WHERE m.project_id = memberships.project_id AND m.person_id = memberships.parent_person_id
      )
    )
  `);
  // A task pointing at someone who is no longer on its project is an orphan the
  // UI renders as a blank assignee. Unassign rather than leave it dangling.
  db.exec(`
    UPDATE tasks SET assigned_to = NULL
    WHERE assigned_to IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.project_id = tasks.project_id AND m.person_id = tasks.assigned_to
    )
  `);
}

/**
 * The tables that turn a task list into a schedule.
 *
 * Five concerns, deliberately not one table:
 *
 *  - `activity_relations`  what must happen before what
 *  - `schedule_imports`    where a batch of activities came from
 *  - `progress_events`     what the field says actually happened
 *  - `evidence`            the proof attached to a report
 *  - `activity_embeddings` the vector used to find the right activity
 *
 * The last three exist now and are written by nothing but the manual path yet.
 * They are here because the field-report layer needs somewhere to land that is
 * not the activity row itself: a report is a *claim* about an activity, and
 * conflating the two would mean an unmatched or rejected claim had nowhere to
 * live and no way to be reviewed.
 */
function installScheduleTables(db: DatabaseSync): void {
  db.exec(`
    -- One row per edge. Successors of X are the rows where X is the
    -- predecessor, so both directions come from one table and can't disagree.
    CREATE TABLE IF NOT EXISTS activity_relations (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      predecessor_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      successor_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      type            TEXT NOT NULL DEFAULT 'FS',   -- FS | SS | FF | SF
      lag_days        INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_edge
      ON activity_relations(predecessor_id, successor_id, type);
    CREATE INDEX IF NOT EXISTS idx_rel_pred ON activity_relations(predecessor_id);
    CREATE INDEX IF NOT EXISTS idx_rel_succ ON activity_relations(successor_id);
    CREATE INDEX IF NOT EXISTS idx_rel_project ON activity_relations(project_id);

    -- Provenance for a batch. Kept so an activity can always answer "which file
    -- and which run put me here", which is the first question asked of any
    -- number that looks wrong.
    CREATE TABLE IF NOT EXISTS schedule_imports (
      id             TEXT PRIMARY KEY,
      project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id        TEXT NOT NULL,
      filename       TEXT,
      sheet_name     TEXT,
      mode           TEXT NOT NULL,          -- create | update
      mapping        TEXT,                   -- JSON: column index -> field
      rows_read      INTEGER NOT NULL DEFAULT 0,
      created_count  INTEGER NOT NULL DEFAULT 0,
      updated_count  INTEGER NOT NULL DEFAULT 0,
      skipped_count  INTEGER NOT NULL DEFAULT 0,
      relations_made INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_imports_project ON schedule_imports(project_id, created_at);

    -- A claim about an activity, not a fact about it. activity_id is nullable
    -- on purpose: a report the matcher could not place still has to be stored
    -- and reviewable, or the queue has nothing to show.
    CREATE TABLE IF NOT EXISTS progress_events (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      activity_id   TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      reported_by   TEXT REFERENCES people(id) ON DELETE SET NULL,
      reported_at   INTEGER NOT NULL,
      source        TEXT NOT NULL,           -- manual | whatsapp | import | system
      raw_text      TEXT,                    -- what was actually said
      progress      INTEGER,                 -- claimed %
      status        TEXT,                    -- claimed status
      actual_start  TEXT,
      actual_finish TEXT,
      quantity      REAL,                    -- "120" of
      unit          TEXT,                    -- "m"
      confidence    REAL,                    -- matcher score, null while unmatched
      match_method  TEXT,                    -- manual | rule | embedding | llm
      review_state  TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | rejected | auto_accepted
      reviewed_by   TEXT,
      reviewed_at   INTEGER,
      review_note   TEXT,
      applied       INTEGER NOT NULL DEFAULT 0,  -- did it move the activity?
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pe_activity ON progress_events(activity_id, reported_at);
    CREATE INDEX IF NOT EXISTS idx_pe_review ON progress_events(project_id, review_state, reported_at);

    -- What an extraction made of one report.
    --
    -- Separate from progress_events, not folded into it, for three reasons:
    -- the same report can be re-read by a better model without destroying what
    -- the last one thought; an extraction is a *reading* and may be wrong in
    -- ways the raw text is not; and the raw text must survive any provider
    -- being swapped out. progress_events stays the inbound record; this is the
    -- understanding of it.
    --
    -- Every column here is nullable on purpose. A field report that says
    -- nothing about location must store a null location, never a guess.
    CREATE TABLE IF NOT EXISTS field_events (
      id           TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      report_id    TEXT NOT NULL REFERENCES progress_events(id) ON DELETE CASCADE,
      work         TEXT,          -- "Foundation excavation"
      progress     INTEGER,       -- 0-100
      status       TEXT,
      event_date   TEXT,          -- resolved to ISO from "today"/"yesterday"
      date_phrase  TEXT,          -- the words that produced it
      location     TEXT,
      discipline   TEXT,
      quantity     REAL,
      unit         TEXT,
      activity_ref TEXT,          -- an Activity ID quoted in the text
      people       TEXT,          -- JSON array
      equipment    TEXT,          -- JSON array
      materials    TEXT,          -- JSON array
      context      TEXT,          -- JSON array of leftover phrases
      raw_text     TEXT NOT NULL, -- copied so an extraction is readable alone
      provider     TEXT NOT NULL, -- mock | openai-compatible | ...
      model        TEXT,
      model_version TEXT,
      ok           INTEGER NOT NULL DEFAULT 1,  -- 0 when the provider output was unusable
      error        TEXT,
      raw_output   TEXT,          -- exactly what the provider returned
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fe_report ON field_events(report_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_fe_project ON field_events(project_id, created_at);

    -- One scoring pass. Append-only: re-running the matcher with different
    -- weights or a better model must not erase what the last run proposed,
    -- because the decision a human made was made against *that* run.
    CREATE TABLE IF NOT EXISTS match_runs (
      id             TEXT PRIMARY KEY,
      project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      report_id      TEXT NOT NULL REFERENCES progress_events(id) ON DELETE CASCADE,
      field_event_id TEXT REFERENCES field_events(id) ON DELETE SET NULL,
      provider       TEXT NOT NULL,
      model          TEXT,
      weights        TEXT NOT NULL,   -- JSON, the exact weighting used
      considered     INTEGER NOT NULL DEFAULT 0,  -- activities scored
      top_score      REAL,
      outcome        TEXT NOT NULL,   -- auto_link_proposed | review | no_candidates
      created_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mr_report ON match_runs(report_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_mr_project ON match_runs(project_id, created_at);

    -- The ranked shortlist for one run, with every signal that produced the
    -- score kept alongside it. Storing the breakdown is what lets the UI say
    -- *why* rather than just how much.
    CREATE TABLE IF NOT EXISTS match_candidates (
      id          TEXT PRIMARY KEY,
      run_id      TEXT NOT NULL REFERENCES match_runs(id) ON DELETE CASCADE,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      activity_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      rank        INTEGER NOT NULL,
      score       REAL NOT NULL,
      signals     TEXT NOT NULL,   -- JSON: { semantic: 0.81, location: 1, ... }
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mc_run ON match_candidates(run_id, rank);
    CREATE INDEX IF NOT EXISTS idx_mc_activity ON match_candidates(activity_id);

    -- What a human (or the auto-link rule) concluded about a run. Append-only:
    -- a reversal is a second row, so "who decided what, when, against which
    -- run" survives being changed later.
    CREATE TABLE IF NOT EXISTS match_decisions (
      id           TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      report_id    TEXT NOT NULL REFERENCES progress_events(id) ON DELETE CASCADE,
      run_id       TEXT REFERENCES match_runs(id) ON DELETE SET NULL,
      activity_id  TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      decision     TEXT NOT NULL,   -- linked | rejected | deferred | auto_linked
      decided_by   TEXT,            -- person id; NULL for the owner or the system
      automatic    INTEGER NOT NULL DEFAULT 0,
      score        REAL,
      note         TEXT,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_md_report ON match_decisions(report_id, created_at);

    -- Metadata only. Bytes live wherever uri points; nothing in this app
    -- stores files yet, and pretending otherwise would be worse than saying so.
    CREATE TABLE IF NOT EXISTS evidence (
      id                TEXT PRIMARY KEY,
      project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      progress_event_id TEXT REFERENCES progress_events(id) ON DELETE CASCADE,
      activity_id       TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      kind              TEXT NOT NULL,       -- photo | document | message | link
      uri               TEXT,
      filename          TEXT,
      mime              TEXT,
      byte_size         INTEGER,
      sha256            TEXT,
      caption           TEXT,
      captured_at       INTEGER,
      created_by        TEXT,
      created_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ev_event ON evidence(progress_event_id);
    CREATE INDEX IF NOT EXISTS idx_ev_activity ON evidence(activity_id);

    -- One vector per activity. text_hash is what makes re-embedding cheap:
    -- if the source text hasn't changed, the vector is still valid.
    CREATE TABLE IF NOT EXISTS activity_embeddings (
      activity_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      model       TEXT NOT NULL,
      dims        INTEGER NOT NULL,
      vector      BLOB NOT NULL,             -- Float32Array bytes
      text_hash   TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_emb_project ON activity_embeddings(project_id);

    -- The filters the schedule view leans on.
    CREATE INDEX IF NOT EXISTS idx_tasks_wbs ON tasks(project_id, wbs);
    CREATE INDEX IF NOT EXISTS idx_tasks_discipline ON tasks(project_id, discipline);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(project_id, status);
  `);
}

/**
 * Invariants the application also enforces, restated where they cannot be
 * bypassed. Application code is the friendly path — it returns a message rather
 * than throwing — and these are the backstop for a bug, a future call site, or
 * someone at the sqlite3 prompt.
 *
 * Triggers rather than foreign keys because the rules are cross-column: a
 * manager must be on the *same project*, which no FK to people(id) can express.
 */
function installGuards(db: DatabaseSync): void {
  const memberCheck = (col: string) => `
    SELECT CASE
      WHEN NEW.${col} = NEW.person_id
        THEN RAISE(ABORT, 'hierarchy: a person cannot report to themselves')
      WHEN NOT EXISTS (
        SELECT 1 FROM memberships m
        WHERE m.project_id = NEW.project_id AND m.person_id = NEW.${col})
        THEN RAISE(ABORT, 'hierarchy: manager is not on this project')
    END;`;

  const assigneeCheck = `
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.project_id = NEW.project_id AND m.person_id = NEW.assigned_to)
      THEN RAISE(ABORT, 'assignment: assignee is not on this project')
    END;`;

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_membership_parent_ins
    BEFORE INSERT ON memberships WHEN NEW.parent_person_id IS NOT NULL
    BEGIN ${memberCheck("parent_person_id")} END;

    CREATE TRIGGER IF NOT EXISTS trg_membership_parent_upd
    BEFORE UPDATE OF parent_person_id ON memberships WHEN NEW.parent_person_id IS NOT NULL
    BEGIN ${memberCheck("parent_person_id")} END;

    CREATE TRIGGER IF NOT EXISTS trg_task_assignee_ins
    BEFORE INSERT ON tasks WHEN NEW.assigned_to IS NOT NULL
    BEGIN ${assigneeCheck} END;

    CREATE TRIGGER IF NOT EXISTS trg_task_assignee_upd
    BEFORE UPDATE OF assigned_to ON tasks WHEN NEW.assigned_to IS NOT NULL
    BEGIN ${assigneeCheck} END;

    -- Progress is a percentage or it is nothing.
    CREATE TRIGGER IF NOT EXISTS trg_task_progress_ins
    BEFORE INSERT ON tasks WHEN NEW.progress < 0 OR NEW.progress > 100
    BEGIN SELECT RAISE(ABORT, 'progress: must be between 0 and 100'); END;

    CREATE TRIGGER IF NOT EXISTS trg_task_progress_upd
    BEFORE UPDATE OF progress ON tasks WHEN NEW.progress < 0 OR NEW.progress > 100
    BEGIN SELECT RAISE(ABORT, 'progress: must be between 0 and 100'); END;

    -- A logic edge that leaves the project, or points at itself, is never a
    -- real dependency — it is a bad import or a bad id.
    CREATE TRIGGER IF NOT EXISTS trg_relation_ins
    BEFORE INSERT ON activity_relations
    BEGIN
      SELECT CASE
        WHEN NEW.predecessor_id = NEW.successor_id
          THEN RAISE(ABORT, 'relation: an activity cannot depend on itself')
        WHEN (SELECT project_id FROM tasks WHERE id = NEW.predecessor_id) IS NOT NEW.project_id
          OR (SELECT project_id FROM tasks WHERE id = NEW.successor_id) IS NOT NEW.project_id
          THEN RAISE(ABORT, 'relation: both activities must be in the same project')
      END;
    END;

    -- A progress event, and any evidence for it, must stay inside its project.
    CREATE TRIGGER IF NOT EXISTS trg_progress_event_ins
    BEFORE INSERT ON progress_events WHEN NEW.activity_id IS NOT NULL
    BEGIN
      SELECT CASE
        WHEN (SELECT project_id FROM tasks WHERE id = NEW.activity_id) IS NOT NEW.project_id
        THEN RAISE(ABORT, 'progress event: activity is in another project')
      END;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_progress_pct_ins
    BEFORE INSERT ON progress_events WHEN NEW.progress IS NOT NULL AND (NEW.progress < 0 OR NEW.progress > 100)
    BEGIN SELECT RAISE(ABORT, 'progress: must be between 0 and 100'); END;

    -- The last line of defence against a bad extraction. Application code
    -- coerces every provider field before it gets here; these make a coercion
    -- bug fail loudly instead of writing 4200% into the record.
    CREATE TRIGGER IF NOT EXISTS trg_field_event_pct_ins
    BEFORE INSERT ON field_events WHEN NEW.progress IS NOT NULL AND (NEW.progress < 0 OR NEW.progress > 100)
    BEGIN SELECT RAISE(ABORT, 'field event: progress must be between 0 and 100'); END;

    CREATE TRIGGER IF NOT EXISTS trg_field_event_project_ins
    BEFORE INSERT ON field_events
    BEGIN
      SELECT CASE WHEN (SELECT project_id FROM progress_events WHERE id = NEW.report_id) IS NOT NEW.project_id
        THEN RAISE(ABORT, 'field event: report is in another project') END;
    END;

    -- A candidate must score inside [0,1] and name an activity in the same
    -- project as the run that produced it.
    CREATE TRIGGER IF NOT EXISTS trg_match_candidate_ins
    BEFORE INSERT ON match_candidates
    BEGIN
      SELECT CASE
        WHEN NEW.score < 0 OR NEW.score > 1
          THEN RAISE(ABORT, 'match candidate: score must be between 0 and 1')
        WHEN (SELECT project_id FROM tasks WHERE id = NEW.activity_id) IS NOT NEW.project_id
          THEN RAISE(ABORT, 'match candidate: activity is in another project')
      END;
    END;
  `);
}

function addColumn(db: DatabaseSync, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

/**
 * Pre-projects, the reporting line lived on `people.parent_id` and there was no
 * project at all. Lift each owner's existing team into a project so nothing is
 * lost. Idempotent: it only runs while an owner has people but no memberships.
 */
function migrateToProjects(db: DatabaseSync): void {
  // Gated on a one-time marker, not on the shape of the data.
  //
  // This used to look for "people with no membership" and lift them into a
  // project. That was true of pre-projects data — and equally true of anyone
  // legitimately removed from every project they were on, who was therefore
  // resurrected on the next boot. Caught in the live database: a person removed
  // through the UI reappeared as a member after a restart.
  db.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  const done = db.prepare("SELECT v FROM meta WHERE k = 'projects_migrated'").get();
  const mark = () =>
    db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('projects_migrated', ?)").run(String(Date.now()));
  if (done) return;

  const stranded = db.prepare(`
    SELECT DISTINCT p.owner_id AS owner_id FROM people p
    WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.person_id = p.id)
  `).all() as { owner_id: string }[];
  if (!stranded.length) { mark(); return; }

  const t = Date.now();
  const mkProject = db.prepare("INSERT INTO projects (id, owner_id, name, code, created_at) VALUES (?, ?, ?, ?, ?)");
  const findProject = db.prepare("SELECT id FROM projects WHERE owner_id = ? ORDER BY created_at LIMIT 1");
  const peopleOf = db.prepare("SELECT id, parent_id, role FROM people WHERE owner_id = ?");
  const place = db.prepare("INSERT OR IGNORE INTO memberships (project_id, person_id, parent_person_id, role, created_at) VALUES (?, ?, ?, ?, ?)");

  for (const { owner_id } of stranded) {
    let project = findProject.get(owner_id) as { id: string } | undefined;
    if (!project) {
      const id = randomId();
      mkProject.run(id, owner_id, "First project", null, t);
      project = { id };
    }
    for (const person of peopleOf.all(owner_id) as { id: string; parent_id: string | null; role: string | null }[]) {
      place.run(project.id, person.id, person.parent_id, person.role, t);
    }
  }
  mark();
}

function randomId(): string {
  return Array.from({ length: 12 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0")).join("");
}

export const db: DatabaseSync = (g.__authDb ??= open());

/**
 * Re-runs the pre-projects migration against the open database.
 *
 * Exists for the test that proves it is a no-op once marked — the marker is
 * what stops a removed person being lifted back into a project on reboot.
 */
export const runProjectMigrationForTests = () => migrateToProjects(db);

/** Single place that decides "now", so tests can reason about expiry. */
export const now = () => Date.now();

let depth = 0;

/**
 * Run `fn` as one atomic unit.
 *
 * Nearly every mutation here is multi-statement — a task insert also stamps a
 * ref, appends to the assignment chain and writes an event — and a throw partway
 * used to leave the task row saying one thing and its history another. Wrapping
 * them means a failure leaves no trace at all.
 *
 * SQLite has no nested transactions, so an inner call uses a SAVEPOINT: an
 * import can wrap the whole batch while each row still goes through the same
 * `createTask` that a form submission uses.
 */
export function tx<T>(fn: () => T): T {
  const inner = depth > 0;
  const name = `sp_${depth}`;
  db.exec(inner ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");
  depth++;
  try {
    const out = fn();
    // The depth counter only holds because every body is synchronous —
    // `node:sqlite` is a sync API and JS is single-threaded, so two requests
    // cannot interleave inside one of these. An awaited body would break that
    // silently, committing another request's statements, so refuse it loudly.
    if (out && typeof (out as { then?: unknown }).then === "function") {
      throw new Error("tx() bodies must be synchronous — an async body would let requests interleave");
    }
    db.exec(inner ? `RELEASE ${name}` : "COMMIT");
    return out;
  } catch (e) {
    // ROLLBACK TO leaves the savepoint open, so release it too — otherwise the
    // outer COMMIT succeeds with the failed statements still pending.
    db.exec(inner ? `ROLLBACK TO ${name}; RELEASE ${name}` : "ROLLBACK");
    throw e;
  } finally {
    depth--;
  }
}
