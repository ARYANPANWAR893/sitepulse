/**
 * Shapes shared between the import server actions and the import UI.
 *
 * Deliberately in its own module with no `server-only`: defining these twice —
 * once server-side, once client-side — lets them drift silently, and the
 * mismatch only surfaces as an unassignable action prop.
 */

export type RowVerdict = "valid" | "warning" | "error";

export type SheetInfo = { index: number; name: string; rows: number; columns: number };

/** One parsed row as the preview table renders it. */
export type PreviewRow = {
  line: number;
  verdict: RowVerdict;
  messages: string[];
  ref: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  startDate: string | null;
  dueDate: string | null;
  assignedTo: string | null;
  assignedToName: string | null;
};

export type ImportFeedback = { error?: string; ok?: string; detail?: string[] };

/**
 * One schedule row as the preview renders it.
 *
 * Wider than PreviewRow because a schedule line carries WBS position, baseline
 * and actual dates and logic links on top of the task fields. `action` is what
 * the commit will do with it, decided during analysis so the preview can say so
 * before anything is written.
 */
export type ActivityPreviewRow = {
  line: number;
  verdict: RowVerdict;
  messages: string[];
  action: "create" | "update" | "skip";

  activityId: string | null;
  title: string;
  description: string | null;
  wbs: string | null;
  wbsPath: string | null;
  discipline: string | null;
  location: string | null;

  status: string;
  progress: number | null;
  plannedStart: string | null;
  plannedFinish: string | null;
  baselineStart: string | null;
  baselineFinish: string | null;
  actualStart: string | null;
  actualFinish: string | null;
  plannedDuration: number | null;

  predecessors: string[];      // raw refs, resolved at commit
  successors: string[];
  notes: string | null;

  assignedTo: string | null;
  assignedToName: string | null;
};

export type ScheduleImportState = ImportFeedback & {
  stagingId?: string;
  filename?: string | null;
  sheets?: SheetInfo[];
  sheetIndex?: number;
  header?: string[];
  mapping?: Record<number, string>;
  rows?: ActivityPreviewRow[];
  shown?: number;
  counts?: Record<string, number>;
  /** create = everything is new; update = matched Activity IDs are refreshed. */
  mode?: "create" | "update";
  /** How many mapped columns the header produced, for the "columns detected" line. */
  mappedColumns?: number;
};

export type ImportState = ImportFeedback & {
  stagingId?: string;
  filename?: string | null;
  sheets?: SheetInfo[];
  sheetIndex?: number;
  header?: string[];
  mapping?: Record<number, string>;
  rows?: PreviewRow[];
  shown?: number;
  counts?: Record<string, number>;
};


/** One parsed person row as the People preview renders it. */
export type PersonPreviewRow = {
  line: number;
  verdict: RowVerdict;
  messages: string[];
  name: string;
  phone: string | null;
  email: string | null;
  title: string | null;
  discipline: string | null;
  reportsToRaw: string | null;
  reportsToId: string | null;      // resolved to an existing member
  reportsToName: string | null;    // may name another row in the same file
};

export type PeopleImportState = ImportFeedback & {
  stagingId?: string;
  filename?: string | null;
  sheets?: SheetInfo[];
  sheetIndex?: number;
  header?: string[];
  mapping?: Record<number, string>;
  rows?: PersonPreviewRow[];
  shown?: number;
  counts?: Record<string, number>;
};
