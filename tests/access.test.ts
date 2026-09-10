import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

process.env.AUTH_SECRET = "test-secret-that-is-definitely-over-32-chars";
process.env.AUTH_DB_PATH = ".data/test-access.db";
for (const s of ["", "-wal", "-shm"]) rmSync(`.data/test-access.db${s}`, { force: true });

let a: typeof import("../src/lib/auth.ts");
let P: typeof import("../src/lib/people.ts");
let R: typeof import("../src/lib/roles.ts");
let A: typeof import("../src/lib/access.ts");
let T: typeof import("../src/lib/tasks.ts");

/** Owner account = the person who creates the project. "L1" in the spec. */
function mkUser(label: string) {
  const id = a.newId();
  a.uq.insert.run(id, label, `${label}@e.com`, null, null, 1, 0, null, Date.now());
  return id;
}

/** A person in the tree who also has a login, so they can act. */
function mkStaff(owner: string, project: string, name: string, parent: string | null, roleName: string) {
  const email = `${name.toLowerCase().replace(/\W+/g, "")}@e.com`;
  const uid = a.newId();
  a.uq.insert.run(uid, name, email, null, null, 1, 0, null, Date.now());

  const res = P.addMember(owner, project, { name, email, parentId: parent });
  assert.ok("ok" in res, `add ${name}: ${JSON.stringify(res)}`);
  const personId = (res as { id: string }).id;

  P.linkPersonToUser(uid, email);
  const role = R.roleByName(owner, roleName)!;
  P.setMemberRole(project, personId, role.id);
  return { userId: uid, personId, name };
}

let owner = "", project = "";
let L2: ReturnType<typeof mkStaff>, L3: ReturnType<typeof mkStaff>, L4: ReturnType<typeof mkStaff>;
let sibling: ReturnType<typeof mkStaff>;

before(async () => {
  a = await import("../src/lib/auth.ts");
  P = await import("../src/lib/people.ts");
  R = await import("../src/lib/roles.ts");
  A = await import("../src/lib/access.ts");
  T = await import("../src/lib/tasks.ts");

  owner = mkUser("l1owner");
  R.listRoles(owner);                        // seed presets
  const pr = P.createProject(owner, { name: "Pipeline", code: "P-1" });
  project = (pr as { id: string }).id;

  // L1 (owner) → L2 → L3 → L4, plus a sibling branch off L2 for isolation tests.
  L2 = mkStaff(owner, project, "Lead Two", null, "Manager");
  L3 = mkStaff(owner, project, "Lead Three", L2.personId, "Manager");
  L4 = mkStaff(owner, project, "Worker Four", L3.personId, "Contributor");
  sibling = mkStaff(owner, project, "Other Branch", null, "Manager");
});

const actorOf = (s: { userId: string; name: string }) => A.actorFor(project, s.userId, s.name)!;
const ownerActor = () => A.actorFor(project, owner, "l1owner")!;
const names = (ids: Set<string>) =>
  [...ids].map((id) => actorOf(L2).members.find((m) => m.id === id)?.name ?? id).sort();

// ---------------------------------------------------------------- identity

describe("actor resolution", () => {
  test("the project owner is the implicit root with the Owner role", () => {
    const act = ownerActor();
    assert.equal(act.isOwner, true);
    assert.equal(act.personId, null);
    assert.equal(act.role.name, "Owner");
    assert.equal(act.depth, 0);
  });

  test("a linked person resolves to themselves at their real depth", () => {
    assert.equal(actorOf(L2).personId, L2.personId);
    assert.equal(actorOf(L2).depth, 1);
    assert.equal(actorOf(L3).depth, 2);
    assert.equal(actorOf(L4).depth, 3);
  });

  test("depth is independent of role — two depths share one role", () => {
    assert.equal(actorOf(L2).role.name, "Manager");
    assert.equal(actorOf(L3).role.name, "Manager");
    assert.notEqual(actorOf(L2).depth, actorOf(L3).depth);
  });

  test("a stranger gets no standing at all", () => {
    const outsider = mkUser("outsider");
    assert.equal(A.actorFor(project, outsider, "outsider"), null);
  });
});

// ------------------------------------------------- the spec's assignment matrix

describe("assignment scope (spec section 2)", () => {
  test("L1 reaches everyone", () => {
    const ids = A.scopeOf(ownerActor());
    assert.deepEqual(names(ids), ["Lead Three", "Lead Two", "Other Branch", "Worker Four"]);
  });

  test("L2 reaches itself and everything below — not the sibling branch", () => {
    assert.deepEqual(names(A.scopeOf(actorOf(L2))), ["Lead Three", "Lead Two", "Worker Four"]);
  });

  test("L3 reaches itself and L4 only", () => {
    assert.deepEqual(names(A.scopeOf(actorOf(L3))), ["Lead Three", "Worker Four"]);
  });

  test("L4, on a self-scope role, reaches only itself", () => {
    assert.deepEqual(names(A.scopeOf(actorOf(L4))), ["Worker Four"]);
  });

  test("assignment never leaks upward or sideways", () => {
    assert.equal(A.canAssignTo(actorOf(L3), L2.personId), false, "no assigning to your own manager");
    assert.equal(A.canAssignTo(actorOf(L2), sibling.personId), false, "no crossing to a sibling branch");
    assert.equal(A.canAssignTo(actorOf(L4), L3.personId), false);
    assert.equal(A.canAssignTo(actorOf(L2), L4.personId), true, "two levels down is fine on subtree");
  });

  test("a direct-scope role stops at direct reports", () => {
    const sup = R.roleByName(owner, "Supervisor")!;
    P.setMemberRole(project, L2.personId, sup.id);
    assert.deepEqual(names(A.scopeOf(actorOf(L2))), ["Lead Three", "Lead Two"]);
    assert.equal(A.canAssignTo(actorOf(L2), L4.personId), false, "grandchild is out of reach now");
    P.setMemberRole(project, L2.personId, R.roleByName(owner, "Manager")!.id);
  });
});

// ---------------------------------------------------------------- tasks

describe("tasks: broad visibility, scoped editing", () => {
  test("everyone sees every task, whoever owns it", () => {
    const t = T.createTask(ownerActor(), { title: "Owner task", assignedTo: sibling.personId });
    assert.ok("ok" in t);
    const all = T.listTasks(project);
    // L4 is bottom of the tree and unrelated to the sibling branch.
    assert.ok(all.some((x) => x.title === "Owner task"), "visible in the project list");
    assert.equal(A.canEditTask(actorOf(L4), all.find((x) => x.title === "Owner task")!), false,
      "…but not editable by someone outside the scope");
  });

  test("creating a task cannot smuggle an out-of-scope assignee", () => {
    const res = T.createTask(actorOf(L3), { title: "Sneaky", assignedTo: L2.personId });
    assert.ok("error" in res, "L3 must not assign upward to L2");
    const res2 = T.createTask(actorOf(L2), { title: "Cross branch", assignedTo: sibling.personId });
    assert.ok("error" in res2, "L2 must not assign across to a sibling branch");
  });

  test("a valid assignment inside scope is written with the assigner recorded", () => {
    const res = T.createTask(actorOf(L2), { title: "Real work", assignedTo: L4.personId });
    assert.ok("ok" in res);
    const t = T.getTask((res as { id: string }).id, project)!;
    assert.equal(t.assigned_to, L4.personId);
    assert.equal(t.assigned_by, L2.personId);
  });

  test("reassigning is refused both ways: bad target, or a task you don't supervise", () => {
    const made = T.createTask(actorOf(L2), { title: "Movable", assignedTo: L3.personId }) as { id: string };
    assert.ok("error" in T.assignTask(actorOf(L2), made.id, sibling.personId), "target out of scope");
    assert.ok("error" in T.assignTask(actorOf(L4), made.id, L4.personId), "task out of L4's scope");
    assert.ok("ok" in T.assignTask(actorOf(L2), made.id, L4.personId));
  });

  test("a role without create_tasks is refused server-side", () => {
    const viewer = R.roleByName(owner, "Viewer")!;
    P.setMemberRole(project, L4.personId, viewer.id);
    assert.ok("error" in T.createTask(actorOf(L4), { title: "Nope" }));
    P.setMemberRole(project, L4.personId, R.roleByName(owner, "Contributor")!.id);
  });

  test("edit scope follows supervision, not ownership of the row", () => {
    const made = T.createTask(ownerActor(), { title: "For L4", assignedTo: L4.personId }) as { id: string };
    const task = T.getTask(made.id, project)!;
    assert.equal(A.canEditTask(actorOf(L2), task), true, "L2 supervises L4");
    assert.equal(A.canEditTask(actorOf(L3), task), true, "so does L3");
    assert.equal(A.canEditTask(actorOf(sibling), task), false, "the sibling branch does not");
  });
});

// ---------------------------------------------------------------- import

describe("task import", () => {
  const csv = (rows: string) => `Task Name,Due Date,Priority,Assigned To\n${rows}`;

  test("rows assigning outside scope are errors, and are never written", () => {
    const before = T.countTasks(project);
    const text = csv(
      `Good one,2026-03-01,high,Worker Four\n` +
      `Upward,2026-03-02,low,Lead Two\n` +          // L3 cannot assign to L2
      `Unknown,2026-03-03,low,Nobody Here\n`
    );
    const act = actorOf(L3);
    const { rows, counts } = T.analyzeImport(act, text);
    assert.equal(counts.valid, 1);
    assert.equal(counts.error, 2);
    assert.match(rows[1].messages.join(" "), /can't assign/i);
    assert.match(rows[2].messages.join(" "), /isn't on this project/i);

    const res = T.commitImport(act, text) as { added: number; skipped: number };
    assert.equal(res.added, 1, "only the valid row lands");
    assert.equal(T.countTasks(project), before + 1);
  });

  test("day-first dates parse, nonsense dates warn rather than fail the row", () => {
    const { rows, counts } = T.analyzeImport(ownerActor(), csv(`Dated,14/03/2026,medium,\nOdd,not-a-date,medium,\n`));
    assert.equal(rows[0].dueDate, "2026-03-14");
    assert.equal(rows[0].verdict, "valid");
    assert.equal(rows[1].verdict, "warning");
    assert.equal(counts.error, 0);
  });

  test("an impossible calendar date is rejected, not rolled over", () => {
    assert.equal(T.cleanDate("31/02/2026"), null);
    assert.equal(T.cleanDate("2026-13-01"), null);
    assert.equal(T.cleanDate("2026-02-28"), "2026-02-28");
  });

  test("a file with no task-name column is refused outright", () => {
    const { fatal } = T.analyzeImport(ownerActor(), "Priority,Due Date\nhigh,2026-01-01\n");
    assert.match(fatal ?? "", /task name/i);
  });
});

// ------------------------------------------------ delegation & history (spec 15, 28, 31)

describe("delegation preserves the assignment chain", () => {
  test("L1 → L2 → L3 → L4 survives two hand-offs", () => {
    // Give everyone a role that can assign, so the chain is about hierarchy.
    const mgr = R.roleByName(owner, "Manager")!;
    for (const p of [L2, L3, L4]) P.setMemberRole(project, p.personId, mgr.id);

    const made = T.createTask(ownerActor(), { title: "Foundation excavation", assignedTo: L2.personId }) as { id: string };

    // L2 hands it to L3, L3 hands it to L4.
    assert.ok("ok" in T.delegateTask(actorOf(L2), made.id, L3.personId));
    assert.ok("ok" in T.delegateTask(actorOf(L3), made.id, L4.personId));

    assert.equal(T.getTask(made.id, project)!.assigned_to, L4.personId, "current owner is L4");

    const chain = T.assignmentHistory(made.id);
    assert.deepEqual(
      chain.map((c) => [c.assigned_by, c.assigned_to, c.assignment_type]),
      [
        [null, L2.personId, "initial"],        // owner has no person row
        [L2.personId, L3.personId, "delegated"],
        [L3.personId, L4.personId, "delegated"],
      ],
      "every hop is kept, in order"
    );
    // The links actually point back up the chain rather than being flat rows.
    assert.equal(chain[0].parent_assignment_id, null);
    assert.equal(chain[1].parent_assignment_id, chain[0].id);
    assert.equal(chain[2].parent_assignment_id, chain[1].id);
  });

  test("you can only delegate a task that is currently yours", () => {
    const made = T.createTask(ownerActor(), { title: "Not yours", assignedTo: L4.personId }) as { id: string };
    const res = T.delegateTask(actorOf(L2), made.id, L3.personId);
    assert.ok("error" in res);
    assert.match(res.error, /assigned to you/i);
  });

  test("delegation cannot reach outside the delegator's scope", () => {
    const made = T.createTask(ownerActor(), { title: "Mine", assignedTo: L3.personId }) as { id: string };
    assert.ok("error" in T.delegateTask(actorOf(L3), made.id, sibling.personId), "sideways is refused");
    assert.ok("error" in T.delegateTask(actorOf(L3), made.id, L2.personId), "upward is refused");
    assert.ok("ok" in T.delegateTask(actorOf(L3), made.id, L4.personId), "downward is allowed");
  });

  test("a role without assign_tasks cannot delegate at all", () => {
    const viewer = R.roleByName(owner, "Viewer")!;
    const made = T.createTask(ownerActor(), { title: "Locked", assignedTo: L4.personId }) as { id: string };
    P.setMemberRole(project, L4.personId, viewer.id);
    const res = T.delegateTask(actorOf(L4), made.id, L4.personId);
    assert.ok("error" in res);
    P.setMemberRole(project, L4.personId, R.roleByName(owner, "Contributor")!.id);
  });

  test("delegationTargets never offers the delegator themselves", () => {
    const targets = T.delegationTargets(actorOf(L2));
    assert.ok(targets.length > 0);
    assert.equal(targets.includes(L2.personId), false);
  });

  test("a Viewer, on scope none, can assign to nobody — not even themselves", () => {
    const viewer = R.roleByName(owner, "Viewer")!;
    assert.equal(viewer.scope, "none");
    P.setMemberRole(project, sibling.personId, viewer.id);
    assert.equal(A.scopeOf(actorOf(sibling)).size, 0);
    assert.equal(A.canAssignTo(actorOf(sibling), sibling.personId), false);
    P.setMemberRole(project, sibling.personId, R.roleByName(owner, "Manager")!.id);
  });
});

describe("spreadsheet import (real P6 shapes)", () => {
  test("column mapping is guessed from P6 header names", () => {
    const header = ["Activity ID", "WBS Code", "Activity Name", "Activity Description",
                    "Planned Start", "Planned Finish", "Status", "Priority", "L3 Owner"];
    const map = T.guessMapping(header);
    assert.equal(map[0], "ref");
    assert.equal(map[2], "title");
    assert.equal(map[4], "startDate");
    assert.equal(map[5], "dueDate");
    assert.equal(map[8], "assignedTo");
  });

  test("Excel serial dates convert, and 'Normal' priority maps to medium", () => {
    const rows = [
      ["Activity ID", "Activity Name", "Planned Start", "Priority"],
      ["SP-1", "Weekly Schedule Update", "46247", "Normal"],
    ];
    const { rows: out, counts } = T.analyzeRows(ownerActor(), rows);
    assert.equal(out[0].startDate, "2026-08-13");
    assert.equal(out[0].priority, "medium");
    assert.equal(out[0].ref, "SP-1");
    assert.equal(counts.error, 0);
  });

  test("an assignee override is re-validated, not trusted", () => {
    const rows = [["Task Name", "Assigned To"], ["Overridden", "Worker Four"]];
    // L3 may not push work to L2, even by overriding the preview.
    const bad = T.commitRows(actorOf(L3), rows, undefined, { 2: L2.personId });
    assert.ok("added" in bad && bad.added === 0, "the out-of-scope override is refused");
    const good = T.commitRows(actorOf(L3), rows, undefined, { 2: L4.personId });
    assert.ok("added" in good && good.added === 1, "an in-scope override is accepted");
  });
});
