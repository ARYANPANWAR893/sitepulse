import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

process.env.AUTH_SECRET = "test-secret-that-is-definitely-over-32-chars";
process.env.AUTH_DB_PATH = ".data/test-people.db";
for (const s of ["", "-wal", "-shm"]) rmSync(`.data/test-people.db${s}`, { force: true });

let a: typeof import("../src/lib/auth.ts");
let P: typeof import("../src/lib/people.ts");

let alice = "", bob = "";

const mkOwner = (label: string) => {
  const id = a.newId();
  a.uq.insert.run(id, label, `${label}${Math.random()}@e.com`, null, null, 1, 0, null, Date.now());
  return id;
};
const project = (owner: string, name = "P" + Math.random()) => {
  const r = P.createProject(owner, { name });
  assert.ok("ok" in r, "project should create");
  return (r as { id: string }).id;
};
const add = (owner: string, proj: string, name: string, parentId: string | null = null) => {
  const r = P.addMember(owner, proj, { name, parentId });
  assert.ok("ok" in r, `add ${name}: ${JSON.stringify(r)}`);
  return (r as { id: string }).id;
};
const treeOf = (proj: string) =>
  P.flatten(P.buildTree(P.listMembers(proj))).map((n) => [n.name, n.depth] as const);

before(async () => {
  a = await import("../src/lib/auth.ts");
  P = await import("../src/lib/people.ts");
  alice = mkOwner("alice"); bob = mkOwner("bob");
});

// ---------------------------------------------------------------- projects

describe("projects", () => {
  test("are scoped to their owner", () => {
    const p = project(alice, "Alice Pipeline");
    assert.ok(P.getProject(p, alice));
    assert.equal(P.getProject(p, bob), null, "Bob must not read Alice's project");
    assert.equal(P.listProjects(bob).some((x) => x.id === p), false);
  });

  test("duplicate names are refused per owner, but allowed across owners", () => {
    P.createProject(alice, { name: "Shared Name" });
    assert.ok("error" in P.createProject(alice, { name: "Shared Name" }));
    assert.ok("ok" in P.createProject(bob, { name: "Shared Name" }), "different account, no clash");
  });

  test("a nameless project is refused", () => {
    assert.ok("error" in P.createProject(alice, { name: "   " }));
    assert.ok("error" in P.createProject(alice, { name: null }));
  });

  test("deleting a project takes its structure but not the people", () => {
    const owner = mkOwner("del");
    const p1 = project(owner), p2 = project(owner);
    add(owner, p1, "Shared Person");
    P.addMember(owner, p2, { name: "Shared Person" });

    assert.equal(P.deleteProject(p1, bob), false, "cross-tenant delete is a no-op");
    assert.equal(P.deleteProject(p1, owner), true);
    assert.equal(P.countMembers(p1), 0);
    assert.equal(P.countMembers(p2), 1, "their placement elsewhere survives");
    assert.equal(P.listRoster(owner).length, 1, "person stays on the roster");
  });
});

// ------------------------------------------------- the point of the feature

describe("one person, different reporting lines per project", () => {
  test("the same person sits under different managers on two projects", () => {
    const owner = mkOwner("multi");
    const p1 = project(owner, "Pipeline A"), p2 = project(owner, "Pipeline B");

    const ekka1 = add(owner, p1, "S. Ekka");
    add(owner, p1, "R. Kandpal", ekka1);

    const sharma = add(owner, p2, "A. Sharma");
    const r2 = P.addMember(owner, p2, { name: "R. Kandpal", parentId: sharma });
    assert.ok("ok" in r2);

    // One identity, two placements.
    assert.equal(P.listRoster(owner).filter((r) => r.name === "R. Kandpal").length, 1);
    assert.equal((r2 as { id: string }).id, P.listMembers(p1).find((m) => m.name === "R. Kandpal")!.id);

    assert.deepEqual(treeOf(p1), [["S. Ekka", 0], ["R. Kandpal", 1]]);
    assert.deepEqual(treeOf(p2), [["A. Sharma", 0], ["R. Kandpal", 1]]);
  });

  test("moving someone on one project leaves the other untouched", () => {
    const owner = mkOwner("iso");
    const p1 = project(owner), p2 = project(owner);
    const boss1 = add(owner, p1, "Boss");
    const kid = add(owner, p1, "Kid", boss1);
    const boss2 = add(owner, p2, "Boss2");
    P.addMember(owner, p2, { name: "Kid", parentId: boss2 });

    assert.ok("ok" in P.setManager(p1, kid, null, owner));
    assert.deepEqual(treeOf(p1).find(([n]) => n === "Kid"), ["Kid", 0]);
    assert.deepEqual(treeOf(p2).find(([n]) => n === "Kid"), ["Kid", 1], "project B unchanged");
  });

  test("a person is reused by phone even under a different spelling of the name", () => {
    const owner = mkOwner("phone");
    const p1 = project(owner), p2 = project(owner);
    P.addMember(owner, p1, { name: "R. Kandpal", phone: "+919876500123" });
    P.addMember(owner, p2, { name: "Ramesh Kandpal", phone: "+919876500123" });
    assert.equal(P.listRoster(owner).length, 1, "matched on phone, not retyped");
  });

  test("the same person can't be added twice to one project", () => {
    const owner = mkOwner("dupe");
    const p = project(owner);
    add(owner, p, "Only Once");
    assert.ok("error" in P.addMember(owner, p, { name: "Only Once" }));
  });
});

// ---------------------------------------------------------------- tenancy

describe("tenancy (IDOR)", () => {
  test("cannot add to, move within, or read another account's project", () => {
    const p = project(alice, "Alice Only");
    const person = add(alice, p, "Alice Crew");

    assert.ok("error" in P.addMember(bob, p, { name: "Intruder" }));
    assert.ok("error" in P.setManager(p, person, null, bob));
    assert.ok("error" in P.removeMember(p, person, bob), "a stranger cannot remove them");
    assert.ok(P.listMembers(p).some((m) => m.id === person), "row survives");
  });

  test("cannot graft onto a manager from a different project", () => {
    const owner = mkOwner("graft");
    const p1 = project(owner), p2 = project(owner);
    const outsider = add(owner, p1, "Outsider");
    assert.ok("error" in P.addMember(owner, p2, { name: "New", parentId: outsider }));
  });
});

// ------------------------------------------------------ re-parenting safety

describe("changing a supervisor", () => {
  test("anyone can be moved, at any depth, including to the top", () => {
    const owner = mkOwner("move");
    const p = project(owner);
    const a1 = add(owner, p, "A");
    const b1 = add(owner, p, "B", a1);
    const c1 = add(owner, p, "C", b1);          // depth 2

    assert.ok("ok" in P.setManager(p, c1, a1, owner), "depth-2 person moved up");
    assert.deepEqual(treeOf(p), [["A", 0], ["B", 1], ["C", 1]]);

    assert.ok("ok" in P.setManager(p, c1, null, owner), "and out to the top");
    assert.deepEqual(treeOf(p), [["A", 0], ["B", 1], ["C", 0]]);
  });

  test("a person cannot report to themselves", () => {
    const owner = mkOwner("self");
    const p = project(owner);
    const x = add(owner, p, "X");
    assert.ok("error" in P.setManager(p, x, x, owner));
  });

  test("a person cannot be moved under their own report — no loops", () => {
    const owner = mkOwner("cycle");
    const p = project(owner);
    const boss = add(owner, p, "Boss");
    const mid = add(owner, p, "Mid", boss);
    const low = add(owner, p, "Low", mid);

    assert.ok("error" in P.setManager(p, boss, mid, owner), "direct report");
    assert.ok("error" in P.setManager(p, boss, low, owner), "grandchild");

    // Nobody vanished, and the tree is intact.
    assert.deepEqual(treeOf(p), [["Boss", 0], ["Mid", 1], ["Low", 2]]);
    assert.equal(P.listMembers(p).length, 3);
  });

  test("validManagers offers neither the person nor anyone below them", () => {
    const owner = mkOwner("valid");
    const p = project(owner);
    const boss = add(owner, p, "Boss");
    const mid = add(owner, p, "Mid", boss);
    add(owner, p, "Low", mid);
    add(owner, p, "Elsewhere");

    const names = P.validManagers(boss, P.listMembers(p)).map((m) => m.name).sort();
    assert.deepEqual(names, ["Elsewhere"], "Mid and Low are descendants; Boss is self");
  });

  test("a move that would bust the depth cap is refused", () => {
    const owner = mkOwner("deep");
    const p = project(owner);
    let parent: string | null = null;
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = P.addMember(owner, p, { name: `L${i}`, parentId: parent });
      if ("error" in r) break;
      ids.push(r.id); parent = r.id;
    }
    const loose = add(owner, p, "Loose");
    // Hanging a 2-deep branch off the bottom of a 10-deep chain must fail.
    add(owner, p, "LooseKid", loose);
    const res = P.setManager(p, loose, ids[ids.length - 1], owner);
    assert.ok("error" in res, "should refuse to exceed the cap");
  });

  test("removing a manager lifts their reports rather than orphaning them", () => {
    const owner = mkOwner("rm");
    const p = project(owner);
    const boss = add(owner, p, "Boss");
    const mid = add(owner, p, "Mid", boss);
    const low = add(owner, p, "Low", mid);

    P.removeMember(p, mid, owner);
    const members = P.listMembers(p);
    assert.equal(members.length, 2);
    assert.equal(members.find((m) => m.id === low)!.parent_person_id, boss);
  });
});

// ---------------------------------------------------------------- tree/CSV

describe("tree and import", () => {
  test("a dangling parent degrades to a root instead of disappearing", () => {
    const owner = mkOwner("dangle");
    const p = project(owner);
    const boss = add(owner, p, "Boss");
    const kid = add(owner, p, "Kid", boss);
    // Simulate a stale pointer without going through removeMember.
    const d = P.listMembers(p);
    assert.equal(d.length, 2);
    P.removeMember(p, boss, owner);
    assert.deepEqual(treeOf(p), [["Kid", 0]]);
    assert.ok(kid);
  });

  test("CSV resolves 'reports to' within the project", () => {
    const owner = mkOwner("csv");
    const p = project(owner);
    const res = P.importRows(owner, p, P.parseCsv("name,reports to\nBoss,\nMid,Boss\nJunior,Mid\n"));
    assert.equal(res.added, 3);
    assert.deepEqual(treeOf(p), [["Boss", 0], ["Mid", 1], ["Junior", 2]]);
  });

  test("CSV aliases, quoted commas and bad rows behave", () => {
    const owner = mkOwner("csv2");
    const p = project(owner);
    const res = P.importRows(owner, p, P.parseCsv(
      'Designation,Mobile,Full Name\nWelder,+919876500999,"Singh, Ravi"\n,,\nFitter,12345,BadPhone\n'));
    assert.equal(res.added, 1);
    assert.equal(P.listMembers(p)[0].name, "Singh, Ravi");
    assert.ok(res.skipped.some((s) => /valid phone/.test(s.why)));
  });

  test("CSV content is stored as data, not executed as SQL", () => {
    const owner = mkOwner("sqli");
    const p = project(owner);
    P.importRows(owner, p, P.parseCsv(`name,role\n"'; DROP TABLE memberships; --",Fitter\n`));
    assert.equal(P.listMembers(p)[0].name, "'; DROP TABLE memberships; --");
    assert.ok(P.countMembers(p) >= 1, "table still exists");
  });

  test("import cannot exceed the per-project cap", () => {
    const owner = mkOwner("cap");
    const p = project(owner);
    const rows = ["name", ...Array.from({ length: P.MAX_ROWS + 40 }, (_, i) => `P${i}`)].join("\n");
    P.importRows(owner, p, P.parseCsv(rows));
    assert.ok(P.countMembers(p) <= P.MAX_ROWS);
  });
});

// ------------------------------------------------ hierarchy levels (spec 7, 13)

describe("hierarchy level is derived, never typed", () => {
  test("levels follow reports-to, and refresh when someone moves", () => {
    const owner = mkOwner("lvl");
    const p = project(owner);
    const a1 = add(owner, p, "A");
    const b1 = add(owner, p, "B", a1);
    const c1 = add(owner, p, "C", b1);

    const level = () =>
      Object.fromEntries(P.listMembers(p).map((m) => [m.name, m.hierarchy_level]));
    assert.deepEqual(level(), { A: 1, B: 2, C: 3 }, "depth 1 = reports to the owner");

    P.setManager(p, c1, a1, owner);
    assert.deepEqual(level(), { A: 1, B: 2, C: 2 }, "moving C up re-levels it");

    P.removeMember(p, b1, owner);
    assert.deepEqual(level(), { A: 1, C: 2 }, "removing a manager re-levels the survivors");
  });
});

// ------------------------------------------------ people import preview (spec 8)

describe("people import validates before writing", () => {
  const setup = () => {
    const owner = mkOwner("imp");
    const p = project(owner);
    return { owner, p, all: () => true as boolean };
  };
  const analyse = (o: string, p: string, csv: string, parent: string | null = null) =>
    P.analyzePeopleRows(o, p, P.parseCsv(csv), parent, () => true);

  test("missing names, bad phones and bad emails are errors", () => {
    const { owner, p } = setup();
    const r = analyse(owner, p,
      "Name,Phone,Email\nGood,+919876543210,a@b.com\n,+919876543211,c@d.com\nBadPhone,12345,\nBadEmail,,not-an-email\n");
    assert.equal(r.counts.valid, 1);
    assert.equal(r.counts.error, 3);
    assert.match(r.rows[1].messages.join(), /No name/i);
    assert.match(r.rows[2].messages.join(), /valid phone/i);
    assert.match(r.rows[3].messages.join(), /valid email/i);
  });

  test("a duplicate inside the same file is rejected", () => {
    const { owner, p } = setup();
    const r = analyse(owner, p, "Name\nRahul\nRahul\n");
    assert.equal(r.rows[0].verdict, "valid");
    assert.equal(r.rows[1].verdict, "error");
    assert.match(r.rows[1].messages.join(), /duplicate of row 2/i);
  });

  test("someone already on the project is rejected", () => {
    const { owner, p } = setup();
    add(owner, p, "Existing");
    const r = analyse(owner, p, "Name\nExisting\n");
    assert.match(r.rows[0].messages.join(), /already on this project/i);
  });

  test("an unknown manager is an error, a blank one defaults to the importer", () => {
    const { owner, p } = setup();
    const boss = add(owner, p, "Boss");
    const r = analyse(owner, p, "Name,Reports To\nKnown,Boss\nOrphan,Ghost\nBlank,\n", boss);
    assert.equal(r.rows[0].verdict, "valid");
    assert.match(r.rows[1].messages.join(), /isn't on this project or in this file/i);
    assert.equal(r.rows[2].reportsToId, boss, "blank falls back to whoever is importing");
  });

  test("a circular reporting line in the file is caught", () => {
    const { owner, p } = setup();
    const r = analyse(owner, p, "Name,Reports To\nRahul,Karan\nKaran,Rahul\n");
    assert.equal(r.counts.error, 2, "both ends of the loop are flagged");
    assert.match(r.rows[0].messages.join(), /circular/i);
    assert.match(r.rows[1].messages.join(), /circular/i);
  });

  test("a longer loop is caught too, and a valid chain is not", () => {
    const { owner, p } = setup();
    const loop = analyse(owner, p, "Name,Reports To\nA,C\nB,A\nC,B\n");
    assert.equal(loop.counts.error, 3);

    const { owner: o2, p: p2 } = setup();
    const chain = analyse(o2, p2, "Name,Reports To\nA,\nB,A\nC,B\n");
    assert.equal(chain.counts.error, 0, "a plain chain is not a loop");
  });

  test("committing writes only the good rows and wires managers named in the file", () => {
    const { owner, p } = setup();
    const csv = "Name,Reports To\nBoss,\nMid,Boss\nJunior,Mid\n,\nDupe,Boss\nDupe,Boss\n";
    const res = P.commitPeopleRows(owner, p, P.parseCsv(csv), null, () => true);
    assert.ok(!("error" in res), "the commit should not fail outright");
    assert.equal(res.added, 4, "Boss, Mid, Junior, Dupe(first)");
    // The all-blank row never reaches the validator — parseCsv drops it — so
    // the only skipped row is the duplicate.
    assert.equal(res.skipped, 1, "the duplicate");

    const flat = P.flatten(P.buildTree(P.listMembers(p)));
    const level = Object.fromEntries(flat.map((n) => [n.name, n.depth]));
    assert.equal(level["Boss"], 0);
    assert.equal(level["Mid"], 1, "manager named in the same file is resolved");
    assert.equal(level["Junior"], 2);
  });

  test("a file with no name column is refused outright", () => {
    const { owner, p } = setup();
    const r = analyse(owner, p, "Phone,Email\n+919876543210,a@b.com\n");
    assert.match(r.fatal ?? "", /name/i);
  });
});
