import "server-only";
import { randomBytes } from "node:crypto";
import { db, now } from "./db.ts";
import { readXlsx, likeliestSheet, type Sheet } from "./xlsx.ts";
import { parseCsv } from "./people.ts";

/**
 * A parked upload. Import is a multi-step flow — choose a file, pick a sheet,
 * map the columns, review, commit — and every step re-reads the *original* file
 * from here. That keeps large workbooks off the wire and means a row can't be
 * edited into validity between the preview and the commit.
 *
 * Rows are scoped by project *and* user, and swept after an hour.
 */

const STALE_MS = 60 * 60 * 1000;
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

const q = {
  insert: db.prepare(`INSERT INTO import_staging
    (id, project_id, user_id, kind, filename, content, is_binary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  get: db.prepare("SELECT * FROM import_staging WHERE id = ? AND project_id = ? AND user_id = ?"),
  sweep: db.prepare("DELETE FROM import_staging WHERE created_at < ?"),
  drop: db.prepare("DELETE FROM import_staging WHERE id = ?"),
};

export type Staged = {
  id: string; filename: string | null;
  sheets: Sheet[];          // a CSV becomes a single pseudo-sheet
  suggested: number;        // index of the sheet most likely to hold the data
  /** Set when the bytes could not be parsed. `sheets` is empty when it is. */
  unreadable?: string;
};

export function stash(
  projectId: string, userId: string, kind: "tasks" | "people",
  filename: string | null, data: Buffer | string
): string {
  q.sweep.run(now() - STALE_MS);
  const id = randomBytes(16).toString("hex");
  const isBinary = typeof data !== "string";
  q.insert.run(id, projectId, userId, kind,
    filename, isBinary ? data.toString("base64") : data, isBinary ? 1 : 0, now());
  return id;
}

/** Scoped read — a staging id from another user or project simply won't match. */
export function load(id: string, projectId: string, userId: string): Staged | null {
  const row = q.get.get(id, projectId, userId) as
    { id: string; filename: string | null; content: string; is_binary: number } | undefined;
  if (!row) return null;

  if (row.is_binary) {
    // A truncated or mislabelled workbook throws out of the ZIP reader. Catching
    // it here rather than at each call site means every step of the import —
    // start, refine, commit — degrades to the same message instead of throwing
    // an unhandled Server Action error at whichever one happened to hit it.
    try {
      const sheets = readXlsx(Buffer.from(row.content, "base64"));
      return { id: row.id, filename: row.filename, sheets, suggested: likeliestSheet(sheets) };
    } catch (e) {
      return {
        id: row.id, filename: row.filename, sheets: [], suggested: 0,
        unreadable: (e as Error).message || "That file couldn't be read.",
      };
    }
  }
  const rows = parseCsv(row.content);
  return {
    id: row.id, filename: row.filename,
    sheets: [{ name: row.filename ?? "Uploaded file", rows }], suggested: 0,
  };
}

export const discard = (id: string) => q.drop.run(id);

/** Names and shapes, for the sheet picker. */
export const describe = (s: Staged) =>
  s.sheets.map((sheet, i) => ({
    index: i,
    name: sheet.name,
    rows: Math.max(0, sheet.rows.length - 1),
    columns: Math.max(0, ...sheet.rows.slice(0, 20).map((r) => r.length)),
  }));
