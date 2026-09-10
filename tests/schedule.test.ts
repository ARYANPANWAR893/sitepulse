import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

process.env.AUTH_SECRET = "test-secret-that-is-definitely-over-32-chars";
process.env.AUTH_DB_PATH = ".data/test-schedule.db";
for (const s of ["", "-wal", "-shm"]) rmSync(`.data/test-schedule.db${s}`, { force: true });

let a: typeof import("../src/lib/auth.ts");
let P: typeof import("../src/lib/people.ts");
let R: typeof import("../src/lib/roles.ts");
let A: typeof import("../src/lib/access.ts");
let T: typeof import("../src/lib/tasks.ts");
let S: typeof import("../src/lib/schedule.ts");
let D: typeof import("../src/lib/db.ts");

function mkUser(label: string) {
  const id = a.newId();
  a.uq.insert.run(id, label, `${label}-${a.newId().slice(0, 6)}@e.com`, null, null, 1, 0, null, Date.now());
  return id;
}

function mkStaff(owner: string, project: string, name: string, parent: string | null, roleName: string) {
  const email = `${name.toLowerCase().replace(/\W+/g, "")}-${a.newId().slice(0, 6)}@e.com`;
  const uid = a.newId();
  a.uq.insert.run(uid, name, email, null, null, 1, 0, null, Date.now());
  const res = P.addMember(owner, project, { name, email, parentId: parent });
  assert.ok("ok" in res, `add ${name}: ${JSON.stringify(res)}`);
  const personId = (res as { id: string }).id;
  P.linkPersonToUser(uid, email);
  P.setMemberRole(project, personId, R.roleByName(owner, roleName)!.id);
  return { userId: uid, personId, name };
}

function world(tag: string) {
  const owner = mkUser(`own-${tag}`);
  R.listRoles(owner);
  const project = (P.createProject(owner, { name: `Proj ${tag}`, code: tag.toUpperCase().slice(0, 4) }) as { id: string }).id;
  const L2 = mkStaff(owner, project, `Two ${tag}`, null, "Manager");
  const L3 = mkStaff(owner, project, `Three ${tag}`, L2.personId, "Manager");
  const L4 = mkStaff(owner, project, `Four ${tag}`, L3.personId, "Contributor");
  const other = mkStaff(owner, project, `Other ${tag}`, null, "Manager");
  const act = (s: { userId: string; name: string }) => A.actorFor(project, s.userId, s.name)!;
  const ownerActor = () => A.actorFor(project, owner, `own-${tag}`)!;
  return { owner, project, L2, L3, L4, other, act, ownerActor };
}

/** A realistic P6-shaped export header plus rows. */
const P6_HEADER = [
  "Activity ID", "Activity Name", "WBS", "WBS Path", "Discipline", "Location",
  "Planned Start", "Planned Finish", "Original Duration", "Predecessors",
  "% Complete", "Status", "Responsible Person",
];

before(async () => {
  a = await import("../src/lib/auth.ts");
  P = await import("../src/lib/people.ts");
  R = await import("../src/lib/roles.ts");
  A = await import("../src/lib/access.ts");
  T = await import("../src/lib/tasks.ts");
  S = await import("../src/lib/schedule.ts");
  D = await import("../src/lib/db.ts");
});

// ---------------------------------------------------------------- parsing

describe("date parsing", () => {
  test("ISO, day-first and Excel serials all land on the same day", () => {
    assert.equal(T.readDate("2026-03-14"), "2026-03-14");
    assert.equal(T.readDate("14/03/2026"), "2026-03-14", "day-first, as an Indian site sheet exports");
    assert.equal(T.readDate("14-03-2026"), "2026-03-14");
    assert.equal(T.readDate("46095"), "2026-03-14", "Excel serial, 1899-12-30 epoch");
  });

  test("impossible and unparseable dates are refused, not rolled over", () => {
    assert.equal(T.readDate("31/02/2026"), null, "February has no 31st");
    assert.equal(T.readDate("not a date"), null);
    assert.equal(T.readDate(""), null);
  });

  test("a bad date warns and blanks the field rather than failing the row", () => {
    const w = world("dt1");
    const res = S.analyzeSchedule(w.ownerActor(), [
      ["Activity ID", "Activity Name", "Planned Start"],
      ["A-1", "Dated", "2026-03-01"],
      ["A-2", "Undated", "sometime in March"],
    ]);
    assert.equal(res.rows[0].plannedStart, "2026-03-01");
    assert.equal(res.rows[1].verdict, "warning");
    assert.equal(res.rows[1].plannedStart, null);
  });

  test("a finish before its start is an error, on both planned and actual", () => {
    const w = world("dt2");
    const res = S.analyzeSchedule(w.ownerActor(), [
      ["Activity Name", "Planned Start", "Planned Finish", "Actual Start", "Actual Finish"],
      ["Backwards planned", "2026-03-10", "2026-03-01", "", ""],
      ["Backwards actual", "", "", "2026-03-10", "2026-03-01"],
    ]);
    assert.equal(res.counts.error, 2);
    assert.match(res.rows[0].messages[0], /Planned finish is before/);
    assert.match(res.rows[1].messages[0], /Actual finish is before/);
  });
});

describe("duration parsing", () => {
  test("bare numbers and P6 duration suffixes both read as whole days", () => {
    assert.equal(S.readDuration("12"), 12);
    assert.equal(S.readDuration("12d"), 12);
    assert.equal(S.readDuration("12 days"), 12);
    assert.equal(S.readDuration("8ed"), 8, "elapsed days");
    assert.equal(S.readDuration("7.4"), 7, "rounded, not truncated to a float");
  });

  test("nonsense and negatives are refused", () => {
    assert.equal(S.readDuration("soon"), null);
    assert.equal(S.readDuration("-3"), null);
    assert.equal(S.readDuration(""), null);
  });
});

describe("predecessor / successor parsing", () => {
  test("a bare list defaults to Finish→Start with no lag", () => {
    assert.deepEqual(S.parseRelationCell("A1010, A1020"), [
      { ref: "A1010", type: "FS", lag: 0 },
      { ref: "A1020", type: "FS", lag: 0 },
    ]);
  });

  test("relationship types and lags are read off the id", () => {
    assert.deepEqual(S.parseRelationCell("A1010FS+2; A1020SS-1; A1030FF"), [
      { ref: "A1010", type: "FS", lag: 2 },
      { ref: "A1020", type: "SS", lag: -1 },
      { ref: "A1030", type: "FF", lag: 0 },
    ]);
  });

  test("a hyphen inside an activity ID is not mistaken for a lag", () => {
    // "B-999" is one id, not activity "B" with a lag of -999.
    assert.deepEqual(S.parseRelationCell("B-999"), [{ ref: "B-999", type: "FS", lag: 0 }]);
    assert.deepEqual(S.parseRelationCell("CIV-100-2"), [{ ref: "CIV-100-2", type: "FS", lag: 0 }]);
    // A typed lag on a hyphenated id still reads correctly.
    assert.deepEqual(S.parseRelationCell("CIV-100SS-3"), [{ ref: "CIV-100", type: "SS", lag: -3 }]);
    // A "+" never appears in an id, so it is safe to read as a lag untyped.
    assert.deepEqual(S.parseRelationCell("A1010+2"), [{ ref: "A1010", type: "FS", lag: 2 }]);
  });

  test("blank and malformed cells yield nothing rather than throwing", () => {
    assert.deepEqual(S.parseRelationCell(""), []);
    assert.deepEqual(S.parseRelationCell("   "), []);
    assert.deepEqual(S.parseRelationCell(",,;"), []);
  });
});

describe("status reading", () => {
  test("common spellings map onto the three states", () => {
    assert.equal(S.readStatus("In Progress", null), "in_progress");
    assert.equal(S.readStatus("WIP", null), "in_progress");
    assert.equal(S.readStatus("Complete", null), "completed");
    assert.equal(S.readStatus("Not Started", null), "not_started");
  });

  test("an absent status column is inferred from percent complete", () => {
    assert.equal(S.readStatus("", 0), "not_started");
    assert.equal(S.readStatus("", 45), "in_progress");
    assert.equal(S.readStatus("", 100), "completed");
    assert.equal(S.readStatus("", null), "not_started", "nothing to go on");
  });
});

// ---------------------------------------------------------------- mapping

describe("column mapping", () => {
  test("a P6 header maps itself without help", () => {
    const map = S.guessScheduleMapping(P6_HEADER);
    const fields = Object.values(map);
    for (const expected of ["activityId", "title", "wbs", "wbsPath", "discipline",
      "location", "plannedStart", "plannedFinish", "plannedDuration",
      "predecessors", "progress", "status", "assignedTo"]) {
      assert.ok(fields.includes(expected), `"${expected}" was not mapped from ${P6_HEADER.join(" | ")}`);
    }
  });

  test("an MS Project header maps too", () => {
    const map = S.guessScheduleMapping(["Unique ID", "Name", "Outline", "Start", "Finish", "Duration", "% Complete"]);
    assert.deepEqual(Object.values(map).sort(),
      ["activityId", "plannedDuration", "plannedFinish", "plannedStart", "progress", "title", "wbsPath"]);
  });

  test("the first column to claim a field keeps it", () => {
    // "Activity Name" must not lose the title to a later bare "Name".
    const map = S.guessScheduleMapping(["Activity Name", "Name"]);
    assert.equal(map[0], "title");
    assert.equal(map[1], undefined);
  });

  test("a new schedule needs a name column; an update needs an Activity ID", () => {
    const w = world("map1");
    const act = w.ownerActor();
    assert.match(S.analyzeSchedule(act, [["Colour", "Size"], ["red", "big"]], undefined, "create").fatal ?? "",
      /Activity name/);
    // An update is matched on Activity ID, so a name column is not required —
    // but the ID is, or there is nothing to match against.
    assert.match(S.analyzeSchedule(act, [["% Complete"], ["50"]], undefined, "update").fatal ?? "",
      /Activity ID/);
    assert.equal(S.analyzeSchedule(act, [["Activity ID", "% Complete"], ["A-1", "50"]], undefined, "update").fatal,
      undefined, "ID plus progress is a valid re-issue");
  });

  test("the analysis reports how many columns it recognised", () => {
    const w = world("map2");
    const res = S.analyzeSchedule(w.ownerActor(), [
      [...P6_HEADER, "Some Column We Don't Know"],
      ["A-1", "Weld", "1.1", "Unit > Piping", "Piping", "Unit 3", "2026-01-01", "2026-01-05", "4", "", "0", "", "", "junk"],
    ]);
    assert.equal(res.mappedColumns, 13, "13 of the 14 columns are understood");
  });
});

// ---------------------------------------------------------------- import

describe("schedule import", () => {
  const rows = (w: ReturnType<typeof world>, tag: string) => [
    P6_HEADER,
    ["A1010", "Excavate trench", "1.1", "Unit 3 > Civil > Earthworks", "Civil", "Unit 3",
      "2026-01-05", "2026-01-12", "7", "", "100", "Complete", `Three ${tag}`],
    ["A1020", "Lay pipe spool", "1.2", "Unit 3 > Piping > Spooling", "Piping", "Unit 3",
      "2026-01-13", "2026-01-25", "12", "A1010", "40", "In Progress", `Four ${tag}`],
    ["A1030", "Hydrotest", "1.2.1", "Unit 3 > Piping > Testing", "Piping", "Unit 3",
      "2026-01-26", "2026-01-30", "4", "A1020FS+2", "0", "Not Started", ""],
  ];

  test("a P6-shaped file imports whole, with fields, logic and assignment", () => {
    const w = world("imp1");
    const res = S.commitSchedule(w.ownerActor(), rows(w, "imp1"), { filename: "p6.xlsx", sheetName: "TASK" });
    assert.ok(!("error" in res), JSON.stringify(res));
    assert.equal(res.created, 3);
    assert.equal(res.updated, 0);
    assert.equal(res.relationsMade, 2, "A1010→A1020 and A1020→A1030");
    assert.equal(res.assigned, 2);

    const all = S.listActivities(w.project);
    assert.equal(all.length, 3);
    const pipe = all.find((x) => x.ref === "A1020")!;
    assert.equal(pipe.title, "Lay pipe spool");
    assert.equal(pipe.wbs, "1.2");
    assert.equal(pipe.wbs_level, 2);
    assert.equal(pipe.wbs_path, "Unit 3 > Piping > Spooling");
    assert.equal(pipe.discipline, "Piping");
    assert.equal(pipe.location, "Unit 3");
    assert.equal(pipe.start_date, "2026-01-05" > "" ? "2026-01-13" : "");
    assert.equal(pipe.due_date, "2026-01-25");
    assert.equal(pipe.planned_duration, 12);
    assert.equal(pipe.progress, 40);
    assert.equal(pipe.status, "in_progress");
    assert.equal(pipe.origin, "import");
    assert.equal(pipe.import_id, res.importId);
  });

  test("logic links point the right way round", () => {
    const w = world("imp2");
    S.commitSchedule(w.ownerActor(), rows(w, "imp2"), {});
    const all = S.listActivities(w.project);
    const dig = all.find((x) => x.ref === "A1010")!;
    const pipe = all.find((x) => x.ref === "A1020")!;

    const ofPipe = S.relationsFor(pipe.id, w.project);
    assert.equal(ofPipe.predecessors.length, 1);
    assert.equal(ofPipe.predecessors[0].other.ref, "A1010", "trench comes first");
    assert.equal(ofPipe.successors.length, 1);
    assert.equal(ofPipe.successors[0].other.ref, "A1030");

    // The same edge read from the other end agrees.
    assert.equal(S.relationsFor(dig.id, w.project).successors[0].other.ref, "A1020");
  });

  test("a link naming an activity that isn't there is reported, not invented", () => {
    const w = world("imp3");
    const res = S.commitSchedule(w.ownerActor(), [
      ["Activity ID", "Activity Name", "Predecessors"],
      ["B-1", "Depends on a ghost", "B-999"],
    ], {});
    assert.ok(!("error" in res));
    assert.equal(res.created, 1);
    assert.equal(res.relationsMade, 0);
    assert.deepEqual(res.unresolvedRefs, ["B-999"]);
  });

  test("a link into a previous import still connects", () => {
    const w = world("imp4");
    const act = w.ownerActor();
    S.commitSchedule(act, [["Activity ID", "Activity Name"], ["C-1", "First batch"]], {});
    const res = S.commitSchedule(act, [
      ["Activity ID", "Activity Name", "Predecessors"], ["C-2", "Second batch", "C-1"],
    ], {});
    assert.ok(!("error" in res));
    assert.equal(res.relationsMade, 1, "resolved against the project, not just this file");
    assert.deepEqual(res.unresolvedRefs, []);
  });

  test("an import records where it came from", () => {
    const w = world("imp5");
    const mapping = S.guessScheduleMapping(P6_HEADER);
    const res = S.commitSchedule(w.ownerActor(), rows(w, "imp5"),
      { filename: "week-12.xlsx", sheetName: "TASK", mapping });
    assert.ok(!("error" in res));
    const rec = S.getImport(res.importId, w.project)!;
    assert.equal(rec.filename, "week-12.xlsx");
    assert.equal(rec.sheet_name, "TASK");
    assert.equal(rec.mode, "create");
    assert.equal(rec.created_count, 3);
    assert.equal(rec.relations_made, 2);
    assert.ok(rec.mapping?.includes("activityId"));
    assert.equal(S.recentImports(w.project).length, 1);
  });

  test("nothing is written when the batch fails part-way", () => {
    const w = world("imp6");
    const before = S.listActivities(w.project).length;
    assert.throws(() => {
      D.tx(() => {
        S.commitSchedule(w.ownerActor(), rows(w, "imp6"), {});
        throw new Error("failure after the batch");
      });
    });
    assert.equal(S.listActivities(w.project).length, before, "the schedule is untouched");
    assert.equal(S.recentImports(w.project).length, 0, "and so is the import log");
  });

  test("an empty or unusable file is reported, never thrown", () => {
    const w = world("imp7");
    const act = w.ownerActor();
    assert.match(S.analyzeSchedule(act, []).fatal ?? "", /empty/);
    assert.ok("error" in S.commitSchedule(act, [], {}));
    assert.ok("error" in S.commitSchedule(act, [["Colour"], ["red"]], {}));
  });

  test("a role without create_tasks cannot import at all", () => {
    const w = world("imp8");
    const viewer = mkStaff(w.owner, w.project, "Viewer imp8", w.L2.personId, "Viewer");
    assert.ok("error" in S.commitSchedule(w.act(viewer), rows(w, "imp8"), {}));
    assert.equal(S.listActivities(w.project).length, 0);
  });
});

// ---------------------------------------------------------------- duplicates

describe("duplicate activity handling", () => {
  test("the same Activity ID twice in one file is an error on the second", () => {
    const w = world("dup1");
    const res = S.analyzeSchedule(w.ownerActor(), [
      ["Activity ID", "Activity Name"], ["D-1", "First"], ["D-1", "Second"],
    ]);
    assert.equal(res.counts.error, 1);
    assert.match(res.rows[1].messages[0], /Duplicate of row 2/);
    assert.equal(res.rows[1].action, "skip");
  });

  test("in create mode, an ID already in the schedule is refused with the fix named", () => {
    const w = world("dup2");
    const act = w.ownerActor();
    const file = [["Activity ID", "Activity Name"], ["E-1", "Original"]];
    assert.equal((S.commitSchedule(act, file, {}) as { created: number }).created, 1);

    const again = S.analyzeSchedule(act, file, undefined, "create");
    assert.equal(again.counts.error, 1);
    assert.match(again.rows[0].messages[0], /switch to Update mode/);
    assert.equal((S.commitSchedule(act, file, {}) as { created: number }).created, 0);
    assert.equal(S.listActivities(w.project).length, 1, "nothing was duplicated");
  });

  test("in update mode the same ID refreshes the activity in place", () => {
    const w = world("dup3");
    const act = w.ownerActor();
    S.commitSchedule(act, [
      ["Activity ID", "Activity Name", "% Complete", "Planned Finish"],
      ["F-1", "Weld spool", "10", "2026-02-01"],
    ], {});
    const first = S.activityByRef(w.project, "F-1")!;

    const res = S.commitSchedule(act, [
      ["Activity ID", "Activity Name", "% Complete", "Planned Finish"],
      ["F-1", "Weld spool (revised)", "65", "2026-02-08"],
    ], { mode: "update" });
    assert.ok(!("error" in res));
    assert.equal(res.updated, 1);
    assert.equal(res.created, 0);

    const after = S.activityByRef(w.project, "F-1")!;
    assert.equal(after.id, first.id, "same row, not a replacement");
    assert.equal(after.title, "Weld spool (revised)");
    assert.equal(after.progress, 65);
    assert.equal(after.due_date, "2026-02-08");
    assert.equal(S.listActivities(w.project).length, 1);
  });

  test("an update file only writes the columns it actually carries", () => {
    const w = world("dup7");
    const act = w.ownerActor();
    S.commitSchedule(act, [
      ["Activity ID", "Activity Name", "WBS", "WBS Path", "Discipline", "Location",
       "Planned Start", "Planned Finish", "Baseline Finish", "Duration", "% Complete"],
      ["U-1", "Trench excavation", "1.1.1", "Unit 3 > Civil > Earthworks", "Civil", "KP0-KP4",
       "2026-01-13", "2026-02-02", "2026-01-30", "20", "65"],
    ], {});

    // A weekly re-issue that carries progress and nothing else. Writing every
    // column would blank WBS, discipline, location and the baseline — which is
    // how a progress update silently destroys a schedule.
    const res = S.commitSchedule(act, [
      ["Activity ID", "% Complete"], ["U-1", "85"],
    ], { mode: "update" });
    assert.ok(!("error" in res));
    assert.equal(res.updated, 1);

    const after = S.activityByRef(w.project, "U-1")!;
    assert.equal(after.progress, 85, "the column the file carried was written");
    assert.equal(after.title, "Trench excavation", "name survived");
    assert.equal(after.wbs, "1.1.1", "WBS survived");
    assert.equal(after.wbs_path, "Unit 3 > Civil > Earthworks");
    assert.equal(after.discipline, "Civil");
    assert.equal(after.location, "KP0-KP4");
    assert.equal(after.start_date, "2026-01-13");
    assert.equal(after.due_date, "2026-02-02");
    assert.equal(after.baseline_finish, "2026-01-30", "the baseline is not collateral damage");
    assert.equal(after.planned_duration, 20);
    assert.equal(after.status, "in_progress", "re-derived from the progress that was supplied");
  });

  test("a mapped but empty cell does clear the field", () => {
    const w = world("dup8");
    const act = w.ownerActor();
    S.commitSchedule(act, [
      ["Activity ID", "Activity Name", "Location"], ["V-1", "Weld", "Unit 3"],
    ], {});
    // Present-and-blank is an instruction; absent is not.
    S.commitSchedule(act, [
      ["Activity ID", "Activity Name", "Location"], ["V-1", "Weld", ""],
    ], { mode: "update" });
    assert.equal(S.activityByRef(w.project, "V-1")!.location, null);
  });

  test("an update file with no assignee column leaves the assignment alone", () => {
    const w = world("dup9");
    const act = w.ownerActor();
    S.commitSchedule(act, [
      ["Activity ID", "Activity Name", "Responsible Person"], ["W-1", "Weld", `Three dup9`],
    ], {});
    S.commitSchedule(act, [["Activity ID", "% Complete"], ["W-1", "50"]], { mode: "update" });
    assert.equal(S.activityByRef(w.project, "W-1")!.assigned_to, w.L3.personId, "still theirs");
  });

  test("update mode still creates rows it has never seen", () => {
    const w = world("dup4");
    const act = w.ownerActor();
    S.commitSchedule(act, [["Activity ID", "Activity Name"], ["G-1", "Known"]], {});
    const res = S.commitSchedule(act, [
      ["Activity ID", "Activity Name"], ["G-1", "Known"], ["G-2", "Brand new"],
    ], { mode: "update" }) as { created: number; updated: number };
    assert.equal(res.updated, 1);
    assert.equal(res.created, 1);
  });

  test("repeated names with no ID are a warning, not a block", () => {
    const w = world("dup5");
    const res = S.analyzeSchedule(w.ownerActor(), [
      ["Activity Name"], ["Hydrotest"], ["Hydrotest"],
    ]);
    assert.equal(res.counts.error, 0, "the same activity recurs across WBS branches");
    assert.equal(res.counts.warning, 1);
  });

  test("rows with no Activity ID get generated, non-colliding ones", () => {
    const w = world("dup6");
    const res = S.commitSchedule(w.ownerActor(), [
      ["Activity Name"], ["One"], ["Two"], ["Three"],
    ], {}) as { created: number };
    assert.equal(res.created, 3);
    const refs = S.listActivities(w.project).map((x) => x.ref);
    assert.equal(new Set(refs).size, 3, `refs collided: ${refs.join(",")}`);
    assert.ok(refs.every((r) => r?.startsWith("DUP6-")), refs.join(","));
  });
});

// ---------------------------------------------------------------- WBS

describe("WBS handling", () => {
  test("level is derived from the dotted code", () => {
    assert.equal(S.wbsLevel("1"), 1);
    assert.equal(S.wbsLevel("1.2"), 2);
    assert.equal(S.wbsLevel("1.2.3.4"), 4);
    assert.equal(S.wbsLevel(null), null);
    assert.equal(S.wbsLevel(""), null);
  });

  test("the tree nests, counts and takes labels from the WBS path", () => {
    const w = world("wbs1");
    S.commitSchedule(w.ownerActor(), [
      ["Activity ID", "Activity Name", "WBS", "WBS Path"],
      ["W-1", "Earthworks", "1.1", "Unit 3 > Civil"],
      ["W-2", "Spooling", "1.2", "Unit 3 > Piping"],
      ["W-3", "Hydrotest", "1.2.1", "Unit 3 > Piping > Testing"],
    ], {});

    const tree = S.buildWbsTree(S.listActivities(w.project));
    assert.equal(tree.length, 1, "one root");
    assert.equal(tree[0].code, "1");
    assert.equal(tree[0].label, "Unit 3");
    assert.equal(tree[0].count, 3, "a parent counts everything beneath it");

    const piping = tree[0].children.find((n) => n.code === "1.2")!;
    assert.equal(piping.label, "Piping");
    assert.equal(piping.count, 2);
    assert.equal(piping.children[0].code, "1.2.1");
    assert.equal(piping.children[0].label, "Testing");
  });

  test("a leaf takes the tail of its path when the code is shallower", () => {
    const w = world("wbs5");
    // "1.3" is two levels of code but three of name — normal in a real export.
    S.commitSchedule(w.ownerActor(), [
      ["Activity ID", "Activity Name", "WBS", "WBS Path"],
      ["P-1", "Stringing", "1.2", "Duliajan > Piping > Laying"],
      ["P-2", "Welding", "1.2.1", "Duliajan > Piping > Welding"],
      ["P-3", "Hydrotest", "1.3", "Duliajan > Piping > Testing"],
    ], {});
    const byCode = new Map(S.flattenWbs(S.buildWbsTree(S.listActivities(w.project))).map((n) => [n.code, n.label]));
    assert.equal(byCode.get("1.3"), "Testing", "a leaf is named by the tail of its path");
    assert.equal(byCode.get("1.2"), "Piping", "a summary level keeps its front-aligned name");
    assert.equal(byCode.get("1.2.1"), "Welding");
  });

  test("a missing summary level is synthesised so nothing is orphaned", () => {
    const w = world("wbs2");
    // The file jumps from 1 straight to 1.2.1 — P6 exports routinely omit
    // summary rows, and the branch must still hang somewhere.
    S.commitSchedule(w.ownerActor(), [
      ["Activity ID", "Activity Name", "WBS"], ["X-1", "Top", "1"], ["X-2", "Deep", "1.2.1"],
    ], {});
    const flat = S.flattenWbs(S.buildWbsTree(S.listActivities(w.project)));
    assert.deepEqual(flat.map((n) => n.code), ["1", "1.2", "1.2.1"]);
  });

  test("filtering by a WBS code includes everything below it", () => {
    const w = world("wbs3");
    S.commitSchedule(w.ownerActor(), [
      ["Activity ID", "Activity Name", "WBS"],
      ["Y-1", "Civil work", "1.1"], ["Y-2", "Piping work", "1.2"], ["Y-3", "Testing", "1.2.1"],
    ], {});
    const all = S.listActivities(w.project);
    assert.deepEqual(S.filterActivities(all, { wbs: "1.2" }).map((x) => x.ref).sort(), ["Y-2", "Y-3"]);
    assert.equal(S.filterActivities(all, { wbs: "1" }).length, 3, "the whole branch, not just exact matches");
    assert.deepEqual(S.filterActivities(all, { wbs: "1.1" }).map((x) => x.ref), ["Y-1"]);
  });

  test("a non-dotted WBS is kept but flagged", () => {
    const w = world("wbs4");
    const res = S.analyzeSchedule(w.ownerActor(), [
      ["Activity Name", "WBS"], ["Odd", "Unit 3 / Piping"],
    ]);
    assert.equal(res.rows[0].verdict, "warning");
    assert.equal(res.rows[0].wbs, "Unit 3 / Piping", "kept verbatim");
  });
});

// ---------------------------------------------------------------- activities

describe("activity creation and updates", () => {
  test("a hand-made activity carries its schedule fields", () => {
    const w = world("act1");
    const res = S.createActivity(w.ownerActor(), {
      title: "Install valve V-101",
      wbs: "2.1", wbsPath: "Unit 4 > Mechanical",
      discipline: "Mechanical", location: "Unit 4",
      plannedStart: "2026-04-01", plannedFinish: "2026-04-03",
      plannedDuration: "3", progress: 0,
    });
    assert.ok("ok" in res, JSON.stringify(res));

    const made = S.getActivity(res.id, w.project)!;
    assert.equal(made.title, "Install valve V-101");
    assert.equal(made.wbs, "2.1");
    assert.equal(made.wbs_level, 2);
    assert.equal(made.discipline, "Mechanical");
    assert.equal(made.planned_duration, 3);
    assert.equal(made.origin, "manual");
    assert.ok(made.ref, "it still gets an Activity ID");
  });

  test("an invalid activity creates nothing at all", () => {
    const w = world("act2");
    const before = S.listActivities(w.project).length;
    const res = S.createActivity(w.ownerActor(), {
      title: "Backwards", plannedStart: "2026-04-10", plannedFinish: "2026-04-01",
    });
    assert.ok("error" in res);
    assert.equal(S.listActivities(w.project).length, before, "the half-made row was rolled back");
  });

  test("an update touches only the fields it was given", () => {
    const w = world("act3");
    const act = w.ownerActor();
    const made = S.createActivity(act, {
      title: "Original", discipline: "Piping", location: "Unit 1",
      plannedStart: "2026-05-01", plannedFinish: "2026-05-10",
    }) as { id: string };

    assert.ok("ok" in S.updateActivity(act, made.id, { progress: 55 }));
    const after = S.getActivity(made.id, w.project)!;
    assert.equal(after.progress, 55);
    assert.equal(after.title, "Original", "untouched");
    assert.equal(after.discipline, "Piping", "untouched");
    assert.equal(after.start_date, "2026-05-01", "untouched");
  });

  test("an update cannot invert the dates", () => {
    const w = world("act4");
    const act = w.ownerActor();
    const made = S.createActivity(act, { title: "Sane", plannedStart: "2026-05-01", plannedFinish: "2026-05-10" }) as { id: string };
    assert.ok("error" in S.updateActivity(act, made.id, { plannedFinish: "2026-04-01" }));
    assert.equal(S.getActivity(made.id, w.project)!.due_date, "2026-05-10", "unchanged");
  });

  test("editing is scoped by supervision, not by depth", () => {
    const w = world("act5");
    const act = w.ownerActor();
    const made = S.createActivity(act, { title: "L4 work", assignedTo: w.L4.personId }) as { id: string };
    // L3 supervises L4, so this is theirs to edit; the sibling branch is not.
    assert.ok("ok" in S.updateActivity(w.act(w.L3), made.id, { progress: 20 }));
    assert.ok("error" in S.updateActivity(w.act(w.other), made.id, { progress: 90 }));
    assert.equal(S.getActivity(made.id, w.project)!.progress, 20);
  });

  test("schedule edits leave the assignment alone", () => {
    const w = world("act6");
    const act = w.ownerActor();
    const made = S.createActivity(act, { title: "Owned", assignedTo: w.L2.personId }) as { id: string };
    const chainBefore = T.assignmentHistory(made.id).length;
    S.updateActivity(act, made.id, { title: "Renamed", progress: 30 });
    assert.equal(S.getActivity(made.id, w.project)!.assigned_to, w.L2.personId);
    assert.equal(T.assignmentHistory(made.id).length, chainBefore, "no chain entry from an edit");
  });
});

// ---------------------------------------------------------------- assignment

describe("assignment association", () => {
  test("an imported assignee opens the chain, marked auto", () => {
    const w = world("as1");
    S.commitSchedule(w.ownerActor(), [
      ["Activity ID", "Activity Name", "Responsible Person"],
      ["H-1", "Weld", `Three as1`],
    ], {});
    const made = S.activityByRef(w.project, "H-1")!;
    assert.equal(made.assigned_to, w.L3.personId);

    const summary = T.assignmentSummary(made.id);
    assert.equal(summary.source, "auto", "the importer decided it");
    assert.equal(summary.original, w.L3.personId);
    // And it is still editable, which is the whole point of marking it.
    assert.ok("ok" in T.assignTask(w.ownerActor(), made.id, w.L4.personId));
    assert.equal(T.assignmentSummary(made.id).current, w.L4.personId);
  });

  test("an unknown assignee warns and imports unassigned", () => {
    const w = world("as2");
    const res = S.commitSchedule(w.ownerActor(), [
      ["Activity ID", "Activity Name", "Responsible Person"],
      ["I-1", "Orphan work", "Nobody Here"],
    ], {}) as { created: number; assigned: number };
    assert.equal(res.created, 1, "the row still lands");
    assert.equal(res.assigned, 0);
    assert.equal(S.activityByRef(w.project, "I-1")!.assigned_to, null);
  });

  test("an import cannot assign outside the importer's scope", () => {
    const w = world("as3");
    // L3 reaches L4 only; naming the sibling branch must fail the row.
    const res = S.analyzeSchedule(w.act(w.L3), [
      ["Activity Name", "Responsible Person"], ["reach across", `Other as3`],
    ]);
    assert.equal(res.counts.error, 1);
    assert.match(res.rows[0].messages[0], /can't assign work to/);
  });

  test("an update import that moves work records the reassignment", () => {
    const w = world("as4");
    const act = w.ownerActor();
    S.commitSchedule(act, [
      ["Activity ID", "Activity Name", "Responsible Person"], ["J-1", "Weld", `Three as4`],
    ], {});
    const made = S.activityByRef(w.project, "J-1")!;

    S.commitSchedule(act, [
      ["Activity ID", "Activity Name", "Responsible Person"], ["J-1", "Weld", `Four as4`],
    ], { mode: "update" });

    const chain = T.assignmentHistory(made.id);
    assert.deepEqual(chain.map((c) => c.assignment_type), ["initial", "reassigned"]);
    assert.equal(chain[0].assigned_to, w.L3.personId, "the original is still on the record");
    assert.equal(chain[1].assigned_to, w.L4.personId);
    assert.equal(S.getActivity(made.id, w.project)!.assigned_to, w.L4.personId);
  });

  test("an update import that repeats the same assignee adds no chain entry", () => {
    const w = world("as5");
    const act = w.ownerActor();
    const file = [["Activity ID", "Activity Name", "Responsible Person"], ["K-1", "Weld", `Three as5`]];
    S.commitSchedule(act, file, {});
    const made = S.activityByRef(w.project, "K-1")!;
    const before = T.assignmentHistory(made.id).length;
    S.commitSchedule(act, file, { mode: "update" });
    assert.equal(T.assignmentHistory(made.id).length, before, "a re-issue is not a reassignment");
  });
});

// ---------------------------------------------------------------- relations

describe("activity relations", () => {
  test("a self-dependency is refused", () => {
    const w = world("rel1");
    const one = S.createActivity(w.ownerActor(), { title: "Alone" }) as { id: string };
    assert.ok("error" in S.linkActivities(w.project, one.id, one.id));
  });

  test("a logic loop is refused before it can be created", () => {
    const w = world("rel2");
    const act = w.ownerActor();
    const A1 = S.createActivity(act, { title: "A" }) as { id: string };
    const B1 = S.createActivity(act, { title: "B" }) as { id: string };
    const C1 = S.createActivity(act, { title: "C" }) as { id: string };
    assert.ok("ok" in S.linkActivities(w.project, A1.id, B1.id));
    assert.ok("ok" in S.linkActivities(w.project, B1.id, C1.id));
    // C → A would close the ring, and a forward pass would never terminate.
    const loop = S.linkActivities(w.project, C1.id, A1.id);
    assert.ok("error" in loop);
    assert.match(loop.error, /loop/);
  });

  test("the database refuses an edge that leaves the project", () => {
    const w1 = world("rel3");
    const w2 = world("rel4");
    const one = S.createActivity(w1.ownerActor(), { title: "Here" }) as { id: string };
    const far = S.createActivity(w2.ownerActor(), { title: "There" }) as { id: string };
    assert.ok("error" in S.linkActivities(w1.project, one.id, far.id));
    // And straight at the SQL layer, past the application check.
    assert.throws(
      () => D.db.prepare(`INSERT INTO activity_relations
        (id, project_id, predecessor_id, successor_id, type, lag_days, created_at)
        VALUES (?, ?, ?, ?, 'FS', 0, ?)`).run("x1", w1.project, one.id, far.id, Date.now()),
      /same project/
    );
  });

  test("an edge can be removed", () => {
    const w = world("rel5");
    const act = w.ownerActor();
    const A1 = S.createActivity(act, { title: "A" }) as { id: string };
    const B1 = S.createActivity(act, { title: "B" }) as { id: string };
    S.linkActivities(w.project, A1.id, B1.id);
    const edge = S.listRelations(w.project)[0];
    assert.ok(S.unlinkActivities(edge.id, w.project));
    assert.equal(S.listRelations(w.project).length, 0);
  });
});

// ---------------------------------------------------------------- progress events

describe("progress events and evidence", () => {
  test("a field report is a claim, not an edit", () => {
    const w = world("pe1");
    const act = w.ownerActor();
    const made = S.createActivity(act, { title: "Weld run", progress: 20 }) as { id: string };

    const ev = S.recordProgressEvent(act, {
      activityId: made.id, source: "manual", rawText: "welded 6 of 10 joints today", progress: 60,
    });
    assert.ok("ok" in ev);
    // The activity has not moved — that is the separation working.
    assert.equal(S.getActivity(made.id, w.project)!.progress, 20);
    assert.equal(S.progressEventsFor(made.id)[0].review_state, "pending");
  });

  test("accepting a report applies it and marks it applied, together", () => {
    const w = world("pe2");
    const act = w.ownerActor();
    const made = S.createActivity(act, { title: "Weld run", progress: 20 }) as { id: string };
    const ev = S.recordProgressEvent(act, { activityId: made.id, progress: 60, actualStart: "2026-06-01" }) as { id: string };

    assert.ok("ok" in S.decideProgressEvent(act, ev.id, "accepted"));
    const after = S.getActivity(made.id, w.project)!;
    assert.equal(after.progress, 60);
    assert.equal(after.actual_start, "2026-06-01");
    const stored = S.progressEventsFor(made.id)[0];
    assert.equal(stored.review_state, "accepted");
    assert.equal(stored.applied, 1);
  });

  test("rejecting a report leaves the activity alone but keeps the claim", () => {
    const w = world("pe3");
    const act = w.ownerActor();
    const made = S.createActivity(act, { title: "Weld run", progress: 20 }) as { id: string };
    const ev = S.recordProgressEvent(act, { activityId: made.id, progress: 95 }) as { id: string };

    assert.ok("ok" in S.decideProgressEvent(act, ev.id, "rejected", "not what the photo shows"));
    assert.equal(S.getActivity(made.id, w.project)!.progress, 20);
    const stored = S.progressEventsFor(made.id)[0];
    assert.equal(stored.review_state, "rejected");
    assert.equal(stored.applied, 0);
    assert.equal(stored.progress, 95, "the claim survives the rejection");
  });

  test("a report with no activity is stored and queued for review", () => {
    const w = world("pe4");
    const act = w.ownerActor();
    const ev = S.recordProgressEvent(act, {
      activityId: null, source: "whatsapp", rawText: "poured the slab near gate 2", confidence: 0.31,
    });
    assert.ok("ok" in ev);
    const pending = S.pendingProgressEvents(w.project);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].activity_id, null, "unmatched reports still have somewhere to live");
    assert.equal(pending[0].confidence, 0.31);
    // It cannot be accepted while it points at nothing.
    assert.ok("error" in S.decideProgressEvent(act, ev.id, "accepted"));
  });

  test("a report cannot be reviewed twice", () => {
    const w = world("pe5");
    const act = w.ownerActor();
    const made = S.createActivity(act, { title: "Once" }) as { id: string };
    const ev = S.recordProgressEvent(act, { activityId: made.id, progress: 50 }) as { id: string };
    assert.ok("ok" in S.decideProgressEvent(act, ev.id, "accepted"));
    assert.ok("error" in S.decideProgressEvent(act, ev.id, "rejected"));
  });

  test("evidence attaches to a report and to its activity", () => {
    const w = world("pe6");
    const act = w.ownerActor();
    const made = S.createActivity(act, { title: "Photographed" }) as { id: string };
    const ev = S.recordProgressEvent(act, { activityId: made.id, progress: 40 }) as { id: string };
    const proof = S.attachEvidence(act, {
      progressEventId: ev.id, activityId: made.id,
      kind: "photo", filename: "joint-6.jpg", mime: "image/jpeg",
      byteSize: 51200, caption: "joint 6 after welding",
    });
    assert.ok("ok" in proof);
    const found = S.evidenceFor(made.id);
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, "photo");
    assert.equal(found[0].progress_event_id, ev.id);
  });
});

// ---------------------------------------------------------------- embeddings

describe("embedding readiness", () => {
  test("match text pulls together everything worth matching on", () => {
    const text = S.matchTextFor({
      ref: "A1020", title: "Lay pipe spool", description: "12 inch CS line",
      wbs_path: "Unit 3 > Piping", discipline: "Piping",
    });
    for (const part of ["A1020", "Lay pipe spool", "Unit 3 > Piping", "Piping", "12 inch CS line"]) {
      assert.ok(text.includes(part), `"${part}" missing from "${text}"`);
    }
  });

  test("every activity starts out needing an embedding", () => {
    const w = world("emb1");
    S.commitSchedule(w.ownerActor(), [
      ["Activity ID", "Activity Name"], ["M-1", "One"], ["M-2", "Two"],
    ], {});
    assert.equal(S.activitiesNeedingEmbedding(w.project).length, 2);
  });

  test("a stored vector round-trips and stops the activity being stale", () => {
    const w = world("emb2");
    S.commitSchedule(w.ownerActor(), [["Activity ID", "Activity Name"], ["N-1", "Weld spool"]], {});
    const made = S.activityByRef(w.project, "N-1")!;

    const vec = new Float32Array([0.1, -0.25, 0.75, 1]);
    S.putEmbedding(made.id, w.project, "test-model", vec, S.matchTextFor(made));

    const back = S.embeddingsIn(w.project);
    assert.equal(back.length, 1);
    assert.equal(back[0].dims, 4);
    assert.deepEqual([...back[0].vector], [...vec], "the bytes survived the round trip");
    assert.equal(S.activitiesNeedingEmbedding(w.project).length, 0);
  });

  test("changing the text makes the vector stale again", () => {
    const w = world("emb3");
    S.commitSchedule(w.ownerActor(), [["Activity ID", "Activity Name"], ["O-1", "Before"]], {});
    const made = S.activityByRef(w.project, "O-1")!;
    S.putEmbedding(made.id, w.project, "m", new Float32Array([1, 2]), S.matchTextFor(made));
    assert.equal(S.activitiesNeedingEmbedding(w.project).length, 0);

    S.updateActivity(w.ownerActor(), made.id, { title: "After" });
    assert.equal(S.activitiesNeedingEmbedding(w.project).length, 1, "re-embed only what changed");
  });
});

// ---------------------------------------------------------------- isolation

describe("project isolation", () => {
  test("activities never leak between projects", () => {
    const w1 = world("pi1");
    const w2 = world("pi2");
    S.commitSchedule(w1.ownerActor(), [["Activity ID", "Activity Name"], ["Z-1", "Private"]], {});

    assert.equal(S.listActivities(w2.project).length, 0);
    assert.equal(S.activityByRef(w2.project, "Z-1"), null);
    const mine = S.activityByRef(w1.project, "Z-1")!;
    assert.equal(S.getActivity(mine.id, w2.project), null);
  });

  test("the same Activity ID is free to exist in both projects", () => {
    const w1 = world("pi3");
    const w2 = world("pi4");
    const file = [["Activity ID", "Activity Name"], ["SHARED-1", "Same id, different job"]];
    assert.equal((S.commitSchedule(w1.ownerActor(), file, {}) as { created: number }).created, 1);
    assert.equal((S.commitSchedule(w2.ownerActor(), file, {}) as { created: number }).created, 1,
      "uniqueness is per project, not global");
  });

  test("an outsider cannot read or edit another project's activity", () => {
    const w1 = world("pi5");
    const w2 = world("pi6");
    const mine = S.createActivity(w1.ownerActor(), { title: "Mine" }) as { id: string };
    const intruder = w2.ownerActor();
    assert.ok("error" in S.updateActivity(intruder, mine.id, { title: "Hijacked" }));
    assert.ok("error" in S.recordProgressEvent(intruder, { activityId: mine.id, progress: 99 }));
    assert.ok("error" in S.attachEvidence(intruder, { activityId: mine.id, kind: "photo" }));
    assert.equal(S.getActivity(mine.id, w1.project)!.title, "Mine", "untouched");
  });

  test("imports and progress events stay inside their project", () => {
    const w1 = world("pi7");
    const w2 = world("pi8");
    const res = S.commitSchedule(w1.ownerActor(), [["Activity Name"], ["Something"]], {}) as { importId: string };
    assert.ok(S.getImport(res.importId, w1.project));
    assert.equal(S.getImport(res.importId, w2.project), null);
    assert.equal(S.recentImports(w2.project).length, 0);
    assert.equal(S.pendingProgressEvents(w2.project).length, 0);
  });
});
