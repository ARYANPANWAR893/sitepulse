import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

process.env.AUTH_SECRET = "test-secret-that-is-definitely-over-32-chars";
process.env.AUTH_DB_PATH = ".data/test-hardening.db";
for (const s of ["", "-wal", "-shm"]) rmSync(`.data/test-hardening.db${s}`, { force: true });

let a: typeof import("../src/lib/auth.ts");
let P: typeof import("../src/lib/people.ts");
let R: typeof import("../src/lib/roles.ts");
let A: typeof import("../src/lib/access.ts");
let T: typeof import("../src/lib/tasks.ts");
let D: typeof import("../src/lib/db.ts");
let S: typeof import("../src/lib/staging.ts");

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

/** A fresh owner + project + L1→L2→L3→L4 chain, isolated from other tests. */
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

before(async () => {
  a = await import("../src/lib/auth.ts");
  P = await import("../src/lib/people.ts");
  R = await import("../src/lib/roles.ts");
  A = await import("../src/lib/access.ts");
  T = await import("../src/lib/tasks.ts");
  D = await import("../src/lib/db.ts");
  S = await import("../src/lib/staging.ts");
});

// ---------------------------------------------------------------- schema

describe("database safety", () => {
  test("foreign keys are on for this connection", () => {
    assert.equal((D.db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
  });

  test("a failed transaction writes nothing", () => {
    const w = world("tx1");
    const before = T.countTasks(w.project);
    assert.throws(() => {
      D.tx(() => {
        T.createTask(w.ownerActor(), { title: "will vanish" });
        throw new Error("boom");
      });
    });
    assert.equal(T.countTasks(w.project), before, "the task inside the aborted transaction is gone");
  });

  test("a nested failure rolls back only the inner unit", () => {
    const w = world("tx2");
    const act = w.ownerActor();
    D.tx(() => {
      T.createTask(act, { title: "outer survives" });
      try {
        D.tx(() => {
          T.createTask(act, { title: "inner vanishes" });
          throw new Error("inner");
        });
      } catch { /* swallowed on purpose */ }
    });
    const titles = T.listTasks(w.project).map((t) => t.title);
    assert.ok(titles.includes("outer survives"));
    assert.ok(!titles.includes("inner vanishes"));
  });

  test("an async transaction body is refused rather than silently interleaving", () => {
    const w = world("txa");
    const before = T.countTasks(w.project);
    assert.throws(
      () => D.tx((() => Promise.resolve(T.createTask(w.ownerActor(), { title: "async" }))) as never),
      /must be synchronous/
    );
    assert.equal(T.countTasks(w.project), before, "and the work inside it is rolled back");
  });

  test("the hierarchy guard refuses a manager from another project", () => {
    const w1 = world("iso1");
    const w2 = world("iso2");
    // Straight past the application checks, at the SQL layer.
    assert.throws(
      () => D.db.prepare("UPDATE memberships SET parent_person_id = ? WHERE project_id = ? AND person_id = ?")
        .run(w2.L2.personId, w1.project, w1.L3.personId),
      /manager is not on this project/
    );
  });

  test("the hierarchy guard refuses a self-parent", () => {
    const w = world("selfp");
    assert.throws(
      () => D.db.prepare("UPDATE memberships SET parent_person_id = ? WHERE project_id = ? AND person_id = ?")
        .run(w.L3.personId, w.project, w.L3.personId),
      /cannot report to themselves/
    );
  });

  test("the assignee guard refuses a task assigned outside its project", () => {
    const w1 = world("asg1");
    const w2 = world("asg2");
    const t = T.createTask(w1.ownerActor(), { title: "guarded" }) as { id: string };
    assert.throws(
      () => D.db.prepare("UPDATE tasks SET assigned_to = ? WHERE id = ?").run(w2.L4.personId, t.id),
      /assignee is not on this project/
    );
  });

  test("progress outside 0-100 is refused at the database", () => {
    const w = world("prog1");
    const t = T.createTask(w.ownerActor(), { title: "pct" }) as { id: string };
    assert.throws(() => D.db.prepare("UPDATE tasks SET progress = 140 WHERE id = ?").run(t.id), /0 and 100/);
    assert.throws(() => D.db.prepare("UPDATE tasks SET progress = -1 WHERE id = ?").run(t.id), /0 and 100/);
  });

  test("task refs stay unique even after a delete", () => {
    const w = world("refs");
    const act = w.ownerActor();
    const first = T.createTask(act, { title: "one" }) as { id: string };
    const firstRef = T.getTask(first.id, w.project)!.ref;
    T.createTask(act, { title: "two" });
    T.deleteTask(act, first.id);
    // Under the old count(*) sequence this reused the freed number.
    const third = T.createTask(act, { title: "three" }) as { id: string };
    const refs = T.listTasks(w.project).map((t) => t.ref);
    assert.equal(new Set(refs).size, refs.length, `refs collided: ${refs.join(",")}`);
    assert.notEqual(T.getTask(third.id, w.project)!.ref, firstRef);
  });
});

// ---------------------------------------------------------------- hierarchy

describe("hierarchy traversal", () => {
  test("scope follows the tree, not the depth number", () => {
    const w = world("tree1");
    const scope = A.scopeOf(w.act(w.L2));
    assert.ok(scope.has(w.L3.personId), "direct report");
    assert.ok(scope.has(w.L4.personId), "grandchild via subtree scope");
    assert.ok(!scope.has(w.other.personId), "the sibling branch is not reachable");
  });

  test("a Supervisor at the top reaches less than a Manager at the bottom", () => {
    const w = world("tree2");
    // Same depth, different role: the shallower person sees fewer people.
    P.setMemberRole(w.project, w.L2.personId, R.roleByName(w.owner, "Supervisor")!.id);
    const shallow = A.scopeOf(w.act(w.L2));
    assert.ok(shallow.has(w.L3.personId), "direct report is in a direct scope");
    assert.ok(!shallow.has(w.L4.personId), "a direct scope stops at one level");
    // Depth alone granted nothing — only the role changed.
    assert.equal(w.act(w.L2).depth, 1);
  });

  test("moving someone re-parents their whole branch and re-levels it", () => {
    const w = world("tree3");
    const res = P.setManager(w.project, w.L3.personId, w.other.personId, w.owner);
    assert.ok("ok" in res);
    const members = P.listMembers(w.project);
    const byId = new Map(members.map((m) => [m.id, m]));
    assert.equal(byId.get(w.L3.personId)!.parent_person_id, w.other.personId);
    assert.equal(byId.get(w.L4.personId)!.parent_person_id, w.L3.personId, "the branch came along");
    assert.equal(byId.get(w.L4.personId)!.hierarchy_level, 3, "levels were recomputed");
  });

  test("a cycle is refused at every depth", () => {
    const w = world("tree4");
    assert.ok("error" in P.setManager(w.project, w.L2.personId, w.L4.personId, w.owner), "grandchild");
    assert.ok("error" in P.setManager(w.project, w.L2.personId, w.L3.personId, w.owner), "child");
    assert.ok("error" in P.setManager(w.project, w.L2.personId, w.L2.personId, w.owner), "self");
  });
});

// ---------------------------------------------------------------- permissions

describe("permissions come from the role, scope from the tree", () => {
  test("a Viewer cannot create, assign or edit", () => {
    const w = world("perm1");
    const v = mkStaff(w.owner, w.project, "Viewer One", w.L2.personId, "Viewer");
    const act = w.act(v);
    assert.ok("error" in T.createTask(act, { title: "nope" }));
    const t = T.createTask(w.ownerActor(), { title: "theirs" }) as { id: string };
    assert.ok("error" in T.assignTask(act, t.id, v.personId));
    assert.ok("error" in T.updateTask(act, t.id, { title: "renamed" }));
  });

  test("a Contributor may raise work but only hold their own", () => {
    const w = world("perm2");
    const act = w.act(w.L4);
    const made = T.createTask(act, { title: "raised by L4" });
    assert.ok("ok" in made, "create_tasks is granted");
    assert.ok("error" in T.assignTask(act, (made as { id: string }).id, w.L3.personId),
      "assign_tasks is not");
  });

  test("a custom role with no preset behind it is honoured", () => {
    const w = world("perm3");
    const custom = R.createRole(
      w.owner, `Inspector ${Date.now()}`, "reads and edits, never assigns",
      ["view_tasks", "edit_tasks"], "subtree"
    );
    assert.ok("ok" in custom, JSON.stringify(custom));
    P.setMemberRole(w.project, w.L2.personId, (custom as { id: string }).id);
    const act = w.act(w.L2);
    assert.ok(A.can(act, "edit_tasks"));
    assert.ok(!A.can(act, "assign_tasks"));
    assert.ok(A.scopeOf(act).has(w.L4.personId), "scope still comes from the tree");
  });

  test("nothing grants permission by depth alone", () => {
    const w = world("perm4");
    // An L2 with the weakest role must not outrank an L4 with a strong one.
    P.setMemberRole(w.project, w.L2.personId, R.roleByName(w.owner, "Viewer")!.id);
    P.setMemberRole(w.project, w.L4.personId, R.roleByName(w.owner, "Manager")!.id);
    assert.ok(!A.can(w.act(w.L2), "create_tasks"), "shallow but weak");
    assert.ok(A.can(w.act(w.L4), "create_tasks"), "deep but strong");
  });
});

// ---------------------------------------------------------------- assignment

describe("assignment and reassignment", () => {
  test("an automatic assignment is still editable afterwards", () => {
    const w = world("as1");
    const act = w.ownerActor();
    const res = T.commitRows(act, [
      ["Task Name", "Assigned To"],
      ["Weld spool 12", `Three as1`],
    ]);
    assert.ok(!("error" in res));
    assert.equal(res.assigned, 1);

    const task = T.listTasks(w.project)[0];
    assert.equal(T.assignmentSummary(task.id).source, "auto", "the importer decided this one");
    assert.ok("ok" in T.assignTask(act, task.id, w.L4.personId), "and a human can override it");
    assert.equal(T.getTask(task.id, w.project)!.assigned_to, w.L4.personId);
  });

  test("re-saving the same assignee is refused rather than padding the chain", () => {
    const w = world("as2");
    const act = w.ownerActor();
    const t = T.createTask(act, { title: "steady", assignedTo: w.L2.personId }) as { id: string };
    const before = T.assignmentHistory(t.id).length;
    assert.ok("error" in T.assignTask(act, t.id, w.L2.personId));
    assert.equal(T.assignmentHistory(t.id).length, before, "no extra row");
  });

  test("unassigning then reassigning does not claim a second 'initial'", () => {
    const w = world("as3");
    const act = w.ownerActor();
    const t = T.createTask(act, { title: "round trip", assignedTo: w.L2.personId }) as { id: string };
    assert.ok("ok" in T.assignTask(act, t.id, null));
    assert.ok("ok" in T.assignTask(act, t.id, w.L3.personId));

    const chain = T.assignmentHistory(t.id);
    assert.deepEqual(chain.map((c) => c.assignment_type), ["initial", "unassigned", "reassigned"]);
    assert.equal(chain.filter((c) => c.assignment_type === "initial").length, 1);
  });

  test("the original assignee survives every later move", () => {
    const w = world("as4");
    const act = w.ownerActor();
    const t = T.createTask(act, { title: "handed around", assignedTo: w.L2.personId }) as { id: string };
    T.assignTask(act, t.id, w.L3.personId);
    T.assignTask(act, t.id, w.other.personId);

    const s = T.assignmentSummary(t.id);
    assert.equal(s.original, w.L2.personId, "first assignee is still recoverable");
    assert.equal(s.current, w.other.personId);
    assert.equal(s.changes, 3);
  });

  test("assignment history is append-only — nothing is ever rewritten", () => {
    const w = world("as5");
    const act = w.ownerActor();
    const t = T.createTask(act, { title: "immutable", assignedTo: w.L2.personId }) as { id: string };
    const firstRowId = T.assignmentHistory(t.id)[0].id;
    T.assignTask(act, t.id, w.L3.personId);
    T.assignTask(act, t.id, null);
    const chain = T.assignmentHistory(t.id);
    assert.equal(chain[0].id, firstRowId, "the first row kept its identity");
    assert.equal(chain[0].assigned_to, w.L2.personId, "and its value");
  });

  test("assignment sources are recorded distinctly", () => {
    const w = world("as6");
    const act = w.ownerActor();
    const t = T.createTask(act, { title: "sourced", assignedTo: w.L2.personId }) as { id: string };
    assert.equal(T.assignmentSummary(t.id).source, "manual");
    assert.ok("ok" in T.delegateTask(w.act(w.L2), t.id, w.L3.personId));
    assert.equal(T.assignmentSummary(t.id).source, "delegation");
  });
});

// ---------------------------------------------------------------- delegation

describe("multi-level delegation", () => {
  test("L1 → L2 → L3 → L4 keeps every link in the chain", () => {
    const w = world("del1");
    const t = T.createTask(w.ownerActor(), { title: "cascade", assignedTo: w.L2.personId }) as { id: string };
    assert.ok("ok" in T.delegateTask(w.act(w.L2), t.id, w.L3.personId));
    // L3 must be able to hold and pass on work, so give them the reach for it.
    assert.ok("ok" in T.delegateTask(w.act(w.L3), t.id, w.L4.personId));

    const chain = T.assignmentHistory(t.id);
    assert.deepEqual(chain.map((c) => c.assigned_to), [w.L2.personId, w.L3.personId, w.L4.personId]);
    assert.deepEqual(chain.map((c) => c.assignment_type), ["initial", "delegated", "delegated"]);
    // Each hop points back at the one before it.
    assert.equal(chain[0].parent_assignment_id, null);
    assert.equal(chain[1].parent_assignment_id, chain[0].id);
    assert.equal(chain[2].parent_assignment_id, chain[1].id);
    assert.equal(T.assignmentSummary(t.id).delegations, 2);
  });

  test("you cannot delegate a task you do not hold", () => {
    const w = world("del2");
    const t = T.createTask(w.ownerActor(), { title: "not yours", assignedTo: w.L3.personId }) as { id: string };
    assert.ok("error" in T.delegateTask(w.act(w.L2), t.id, w.L4.personId));
  });

  test("delegation cannot go upward or sideways", () => {
    const w = world("del3");
    const t = T.createTask(w.ownerActor(), { title: "downhill only", assignedTo: w.L3.personId }) as { id: string };
    assert.ok("error" in T.delegateTask(w.act(w.L3), t.id, w.L2.personId), "upward refused");
    assert.ok("error" in T.delegateTask(w.act(w.L3), t.id, w.other.personId), "sideways refused");
    assert.ok("ok" in T.delegateTask(w.act(w.L3), t.id, w.L4.personId), "downward allowed");
  });

  test("the owner can reassign work that has been delegated away", () => {
    const w = world("del4");
    const act = w.ownerActor();
    const t = T.createTask(act, { title: "recalled", assignedTo: w.L2.personId }) as { id: string };
    T.delegateTask(w.act(w.L2), t.id, w.L3.personId);
    assert.ok("ok" in T.assignTask(act, t.id, w.other.personId));

    const chain = T.assignmentHistory(t.id);
    assert.equal(chain.length, 3, "the delegation is still on the record");
    assert.equal(chain[1].assignment_type, "delegated");
    assert.equal(chain[2].assignment_type, "reassigned");
  });
});

// ---------------------------------------------------------------- imports

describe("import validation and duplicates", () => {
  const HEAD = ["Activity ID", "Activity Name", "Planned Finish", "L3 Owner"];

  test("a duplicate task id inside one file is rejected once, not twice", () => {
    const w = world("imp1");
    const res = T.analyzeRows(w.ownerActor(), [
      HEAD, ["A-1", "First", "2026-01-01", ""], ["A-1", "Second", "2026-01-02", ""],
    ]);
    assert.equal(res.counts.error, 1);
    assert.match(res.rows[1].messages[0], /Duplicate of row 2/);
  });

  test("a task id already in the project is rejected on re-import", () => {
    const w = world("imp2");
    const act = w.ownerActor();
    const rows = [HEAD, ["B-1", "Only once", "2026-01-01", ""]];
    assert.equal((T.commitRows(act, rows) as { added: number }).added, 1);
    const second = T.analyzeRows(act, rows);
    assert.equal(second.counts.error, 1);
    assert.match(second.rows[0].messages[0], /already in this project/);
    assert.equal((T.commitRows(act, rows) as { added: number }).added, 0, "and nothing is written twice");
  });

  test("repeated names with no id warn rather than block", () => {
    const w = world("imp3");
    const res = T.analyzeRows(w.ownerActor(), [
      ["Task Name"], ["Hydrotest"], ["Hydrotest"],
    ]);
    assert.equal(res.counts.error, 0, "the same activity legitimately recurs across a WBS");
    assert.equal(res.counts.warning, 1);
  });

  test("a malformed file is reported, not thrown", () => {
    const w = world("imp4");
    const act = w.ownerActor();
    assert.match((T.analyzeRows(act, []) as { fatal?: string }).fatal ?? "", /empty/);
    assert.match((T.analyzeRows(act, [["Nothing", "Useful"]]) as { fatal?: string }).fatal ?? "", /Task name/);
    assert.ok("error" in T.commitRows(act, []));
  });

  test("an import either lands whole or not at all", () => {
    const w = world("imp5");
    const act = w.ownerActor();
    const before = T.countTasks(w.project);
    assert.throws(() => {
      D.tx(() => {
        T.commitRows(act, [["Task Name"], ["a"], ["b"], ["c"]]);
        throw new Error("failure after the batch");
      });
    });
    assert.equal(T.countTasks(w.project), before, "no partial write survived");
  });

  test("the commit says what happened to every row", () => {
    const w = world("imp6");
    const res = T.commitRows(w.ownerActor(), [
      HEAD,
      ["C-1", "Assigned one", "2026-01-01", "Three imp6"],
      ["C-2", "Nobody home", "2026-01-01", "Ghost Person"],
      ["C-3", "Unassigned one", "2026-01-01", ""],
    ]);
    assert.ok(!("error" in res));
    assert.equal(res.added, 2);
    assert.equal(res.assigned, 1);
    assert.equal(res.unassigned, 1);
    assert.equal(res.skipped, 1);
    assert.ok(res.reasons.some((m) => /isn't on this project/.test(m)), res.reasons.join(" | "));
  });

  test("an import cannot assign outside the importer's scope", () => {
    const w = world("imp7");
    // L3 supervises L4 only; naming the sibling branch must fail.
    const res = T.analyzeRows(w.act(w.L3), [
      ["Task Name", "Assigned To"], ["reach across", "Other imp7"],
    ]);
    assert.equal(res.counts.error, 1);
    assert.match(res.rows[0].messages[0], /can't assign work to/);
  });

  test("people import: duplicates and unknown managers are caught before any write", () => {
    const w = world("imp8");
    const csv = "Name,Reports To\nAlpha,\nAlpha,\nBeta,Nowhere Person\nGamma,Alpha\n";
    const res = P.commitPeopleRows(w.owner, w.project, P.parseCsv(csv), null, () => true);
    assert.ok(!("error" in res));
    assert.equal(res.added, 2, "Alpha and Gamma");
    assert.equal(res.skipped, 2, "the repeat and the unknown manager");
    assert.equal(res.linked, 1, "Gamma was wired to Alpha from inside the file");
  });

  test("people import: a circular file is refused entirely", () => {
    const w = world("imp9");
    const res = P.commitPeopleRows(
      w.owner, w.project, P.parseCsv("Name,Reports To\nX,Y\nY,X\n"), null, () => true
    );
    assert.ok(!("error" in res));
    assert.equal(res.added, 0);
    assert.equal(res.skipped, 2);
  });
});

describe("staged uploads", () => {
  test("a corrupt workbook is reported, never thrown", () => {
    const w = world("stg1");
    const id = S.stash(w.project, w.owner, "tasks", "broken.xlsx", Buffer.from("PK not really a zip"));
    // The whole point: load() must not throw, or the Server Action 500s.
    const st = S.load(id, w.project, w.owner);
    assert.ok(st, "the row is still found");
    assert.equal(st.sheets.length, 0);
    assert.match(st.unreadable ?? "", /valid \.xlsx/);
  });

  test("a staged upload is scoped to its project and its uploader", () => {
    const w1 = world("stg2");
    const w2 = world("stg3");
    const id = S.stash(w1.project, w1.owner, "tasks", "mine.csv", "Task Name\nprivate row\n");
    assert.ok(S.load(id, w1.project, w1.owner), "the owner can read it back");
    assert.equal(S.load(id, w2.project, w2.owner), null, "another project cannot");
    assert.equal(S.load(id, w1.project, w2.owner), null, "another user cannot");
  });
});

// ---------------------------------------------------------------- isolation

describe("project isolation", () => {
  test("an actor from another project resolves to nothing", () => {
    const w1 = world("pi1");
    const w2 = world("pi2");
    assert.equal(A.actorFor(w1.project, w2.L2.userId, w2.L2.name), null);
    assert.equal(A.actorFor(w1.project, w2.owner, "stranger"), null);
  });

  test("a task id from another project is invisible and unmutable", () => {
    const w1 = world("pi3");
    const w2 = world("pi4");
    const t = T.createTask(w1.ownerActor(), { title: "private" }) as { id: string };
    const intruder = w2.ownerActor();
    assert.equal(T.getTask(t.id, w2.project), null);
    assert.ok("error" in T.updateTask(intruder, t.id, { title: "hijacked" }));
    assert.ok("error" in T.assignTask(intruder, t.id, w2.L2.personId));
    assert.ok("error" in T.deleteTask(intruder, t.id));
    assert.equal(T.getTask(t.id, w1.project)!.title, "private", "untouched");
  });

  test("the same person on two projects carries no scope between them", () => {
    const w1 = world("pi5");
    const w2 = world("pi6");
    // Place w1's L2 onto w2 as a leaf under someone else.
    const shared = P.addMember(w2.owner, w2.project, { name: `Two pi5`, parentId: w2.L3.personId });
    assert.ok("ok" in shared, JSON.stringify(shared));
    const members2 = P.listMembers(w2.project);
    assert.ok(members2.some((m) => m.name === "Two pi5"));
    // Their reach on w1 is unchanged and does not include anyone from w2.
    const scope1 = A.scopeOf(w1.act(w1.L2));
    for (const m of members2) {
      if (!P.listMembers(w1.project).some((x) => x.id === m.id)) {
        assert.ok(!scope1.has(m.id), "no cross-project reach");
      }
    }
  });
});

// ---------------------------------------------------------------- audit

describe("auditability", () => {
  const kindsFor = (projectId: string, taskId: string) =>
    T.recentEvents(projectId, 200).filter((e) => e.task_id === taskId).map((e) => e.kind);

  test("every task mutation leaves an event", () => {
    const w = world("aud1");
    const act = w.ownerActor();
    const t = T.createTask(act, { title: "tracked", assignedTo: w.L2.personId }) as { id: string };
    T.updateTask(act, t.id, { title: "tracked", status: "in_progress" });
    T.updateTask(act, t.id, { title: "tracked", status: "in_progress", progress: 40 });
    T.delegateTask(w.act(w.L2), t.id, w.L3.personId);
    T.assignTask(act, t.id, null);
    T.deleteTask(act, t.id);

    const kinds = kindsFor(w.project, t.id);
    for (const expected of ["created", "assigned", "status_changed", "progress_changed", "delegated", "unassigned", "deleted"]) {
      assert.ok(kinds.includes(expected), `missing "${expected}" — got ${kinds.join(",")}`);
    }
  });

  test("the deletion record outlives the task", () => {
    const w = world("aud2");
    const act = w.ownerActor();
    const t = T.createTask(act, { title: "gone soon" }) as { id: string };
    T.deleteTask(act, t.id);
    assert.equal(T.getTask(t.id, w.project), null);
    assert.ok(kindsFor(w.project, t.id).includes("deleted"), "the event survives the cascade");
  });

  test("people changes are on the same feed", () => {
    const w = world("aud3");
    P.setManager(w.project, w.L4.personId, w.L2.personId, w.owner);
    P.setMemberRole(w.project, w.L4.personId, R.roleByName(w.owner, "Supervisor")!.id);
    const removal = P.removeMember(w.project, w.other.personId, w.owner);
    assert.ok("ok" in removal);

    const kinds = T.recentEvents(w.project, 200).map((e) => e.kind);
    for (const expected of ["person_added", "person_moved", "role_changed", "person_removed"]) {
      assert.ok(kinds.includes(expected), `missing "${expected}" — got ${[...new Set(kinds)].join(",")}`);
    }
  });

  test("removing someone from every project does not resurrect them on reboot", () => {
    const w = world("aud6");
    assert.ok("ok" in P.removeMember(w.project, w.other.personId, w.owner));
    assert.ok(!P.listMembers(w.project).some((m) => m.id === w.other.personId));

    // The legacy pre-projects migration used to read "person with no
    // membership" as "needs lifting into a project", which is also the state of
    // anyone legitimately removed. Re-running it must be a no-op now.
    D.runProjectMigrationForTests();
    assert.ok(!P.listMembers(w.project).some((m) => m.id === w.other.personId),
      "they stayed removed");
    // And they are still on the roster, so their history remains nameable.
    assert.ok(P.listRoster(w.owner).some((p) => p.id === w.other.personId));
  });

  test("a departed person is still nameable from the chain", () => {
    const w = world("aud5");
    const act = w.ownerActor();
    const t = T.createTask(act, { title: "who had this?", assignedTo: w.L4.personId }) as { id: string };
    assert.ok("ok" in P.removeMember(w.project, w.L4.personId, w.owner));

    // Gone from the project…
    assert.ok(!P.listMembers(w.project).some((m) => m.id === w.L4.personId));
    // …but the chain still points at them, and the roster still has the name,
    // which is what lets the history render "reassigned to Four aud5" instead
    // of the "someone" it used to degrade to.
    const chain = T.assignmentHistory(t.id);
    assert.equal(chain[0].assigned_to, w.L4.personId);
    const roster = new Map(P.listRoster(w.owner).map((p) => [p.id, p.name]));
    assert.equal(roster.get(w.L4.personId), "Four aud5");
  });

  test("removing someone hands their work back rather than orphaning it", () => {
    const w = world("aud4");
    const act = w.ownerActor();
    const t = T.createTask(act, { title: "held by a leaver", assignedTo: w.L4.personId }) as { id: string };
    const res = P.removeMember(w.project, w.L4.personId, w.owner);
    assert.ok("ok" in res);
    assert.equal(res.released, 1);

    const task = T.getTask(t.id, w.project)!;
    assert.equal(task.assigned_to, null, "no longer points at a non-member");
    const chain = T.assignmentHistory(t.id);
    assert.equal(chain[chain.length - 1].assignment_type, "unassigned");
    assert.equal(chain[0].assigned_to, w.L4.personId, "who held it is still on the record");
  });
});
