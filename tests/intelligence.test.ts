import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

process.env.AUTH_SECRET = "test-secret-that-is-definitely-over-32-chars";
process.env.AUTH_DB_PATH = ".data/test-intelligence.db";
for (const s of ["", "-wal", "-shm"]) rmSync(`.data/test-intelligence.db${s}`, { force: true });

let a: typeof import("../src/lib/auth.ts");
let P: typeof import("../src/lib/people.ts");
let R: typeof import("../src/lib/roles.ts");
let A: typeof import("../src/lib/access.ts");
let S: typeof import("../src/lib/schedule.ts");
let D: typeof import("../src/lib/db.ts");
let L: typeof import("../src/lib/llm/index.ts");
let M: typeof import("../src/lib/matching.ts");
let I: typeof import("../src/lib/intake.ts");

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
  assert.ok("ok" in res, `add ${name}`);
  const personId = (res as { id: string }).id;
  P.linkPersonToUser(uid, email);
  P.setMemberRole(project, personId, R.roleByName(owner, roleName)!.id);
  return { userId: uid, personId, name };
}

/**
 * A refinery-shaped schedule, deliberately containing near-miss activities:
 * two foundation excavations in different units, and a cable trench that shares
 * the word "trench". Text similarity alone must not be able to tell them apart.
 */
const SCHEDULE = [
  ["Activity ID", "Activity Name", "WBS", "WBS Path", "Discipline", "Location",
   "Planned Start", "Planned Finish", "Responsible Person"],
  ["CDU-1010", "CDU Foundation Excavation", "1.1", "Refinery > Civil > Foundations", "Civil", "CDU",
   "2026-03-01", "2026-03-20", "Rahul Verma"],
  ["CDU-1020", "CDU Foundation Preparation", "1.1.1", "Refinery > Civil > Foundations", "Civil", "CDU",
   "2026-03-01", "2026-03-10", "Rahul Verma"],
  ["ELE-2010", "Cable Trench Excavation", "2.1", "Refinery > Electrical > Trenching", "Electrical", "CDU",
   "2026-03-15", "2026-04-02", "Vivek Rao"],
  ["VDU-1010", "VDU Foundation Excavation", "3.1", "Refinery > Civil > Foundations", "Civil", "VDU",
   "2026-03-01", "2026-03-20", "Karan Singh"],
  ["TNK-4010", "Tank farm hydrotest", "4.1", "Refinery > Piping > Testing", "Piping", "Tank Farm",
   "2026-05-01", "2026-05-20", ""],
];

function world(tag: string) {
  const owner = mkUser(`own-${tag}`);
  R.listRoles(owner);
  const project = (P.createProject(owner, { name: `Refinery ${tag}`, code: tag.slice(0, 4).toUpperCase() }) as { id: string }).id;
  const rahul = mkStaff(owner, project, "Rahul Verma", null, "Manager");
  const vivek = mkStaff(owner, project, "Vivek Rao", null, "Manager");
  const karan = mkStaff(owner, project, "Karan Singh", rahul.personId, "Contributor");
  const ownerActor = () => A.actorFor(project, owner, `own-${tag}`)!;
  const act = (s: { userId: string; name: string }) => A.actorFor(project, s.userId, s.name)!;
  const res = S.commitSchedule(ownerActor(), SCHEDULE, {});
  assert.ok(!("error" in res), JSON.stringify(res));
  return { owner, project, rahul, vivek, karan, ownerActor, act };
}

/** Always returns exactly this, so provider failure modes can be pinned. */
function fakeProvider(over: Partial<import("../src/lib/llm/types.ts").ExtractionResult>) {
  return {
    name: "fake", model: "fake-1",
    async extractFieldEvent() {
      return {
        event: { ...L.EMPTY_FIELD_EVENT }, provider: "fake", model: "fake-1",
        modelVersion: null, raw: null, ok: true, error: null, ...over,
      };
    },
  } as import("../src/lib/llm/types.ts").LlmProvider;
}

/** A provider that returns whatever garbage you hand it, before coercion. */
function garbageProvider(raw: string) {
  return {
    name: "garbage", model: "g",
    async extractFieldEvent() {
      const parsed = L.parseJsonObject(raw);
      return parsed
        ? { event: L.coerceFieldEvent(parsed), provider: "garbage", model: "g", modelVersion: null, raw, ok: true, error: null }
        : { event: { ...L.EMPTY_FIELD_EVENT }, provider: "garbage", model: "g", modelVersion: null, raw, ok: false, error: "not JSON" };
    },
  } as import("../src/lib/llm/types.ts").LlmProvider;
}

const REPORT = "Foundation excavation 80% complete near CDU today. Crew moved to cable trench.";

before(async () => {
  a = await import("../src/lib/auth.ts");
  P = await import("../src/lib/people.ts");
  R = await import("../src/lib/roles.ts");
  A = await import("../src/lib/access.ts");
  S = await import("../src/lib/schedule.ts");
  D = await import("../src/lib/db.ts");
  L = await import("../src/lib/llm/index.ts");
  M = await import("../src/lib/matching.ts");
  I = await import("../src/lib/intake.ts");
});

// ---------------------------------------------------------------- extraction

describe("understanding a field report", () => {
  const ctx = () => ({
    now: Date.parse("2026-03-12T09:00:00Z"),
    locations: ["CDU", "VDU", "Tank Farm"],
    disciplines: ["Civil", "Electrical", "Piping"],
    people: ["Rahul Verma", "Vivek Rao"],
    activityRefs: ["CDU-1010", "ELE-2010"],
  });

  test("the worked example reads the way the spec describes it", async () => {
    const { event } = await new L.MockProvider().extractFieldEvent(REPORT, ctx());
    assert.match(event.work ?? "", /foundation excavation/i);
    assert.equal(event.progress, 80);
    assert.equal(event.location, "CDU");
    assert.equal(event.date, "2026-03-12", "\"today\" resolved against the report timestamp");
    assert.equal(event.datePhrase, "today");
    assert.ok(event.context.some((c) => /cable trench/i.test(c)), event.context.join(" | "));
  });

  test("80% complete is in progress, not completed", async () => {
    const { event } = await new L.MockProvider().extractFieldEvent(REPORT, ctx());
    assert.equal(event.status, "in_progress");
    const done = await new L.MockProvider().extractFieldEvent("Foundation excavation 100% complete at CDU", ctx());
    assert.equal(done.event.status, "completed");
  });

  test("what the report does not say comes back null, never guessed", async () => {
    const { event } = await new L.MockProvider().extractFieldEvent("Poured some concrete", ctx());
    assert.equal(event.location, null, "no location in the text");
    assert.equal(event.discipline, null);
    assert.equal(event.progress, null);
    assert.equal(event.date, null);
    assert.equal(event.quantity, null);
    assert.equal(event.unit, null);
    assert.equal(event.activityRef, null);
    assert.deepEqual(event.people, []);
    assert.deepEqual(event.equipment, []);
  });

  test("a location outside the project vocabulary is not invented", async () => {
    const { event } = await new L.MockProvider().extractFieldEvent("Work progressing near Atlantis", ctx());
    assert.equal(event.location, null, "Atlantis is not a place this project knows");
  });

  test("quantities and units are read only when stated", async () => {
    const { event } = await new L.MockProvider().extractFieldEvent("Laid 120 m of cable at CDU", ctx());
    assert.equal(event.quantity, 120);
    assert.equal(event.unit, "m");
    const pctOnly = await new L.MockProvider().extractFieldEvent("Excavation 45% done at CDU", ctx());
    assert.equal(pctOnly.event.quantity, null, "a percentage is not a quantity");
  });

  test("a quoted activity ID is recognised, an unknown one is not", async () => {
    const hit = await new L.MockProvider().extractFieldEvent("CDU-1010 excavation continuing", ctx());
    assert.equal(hit.event.activityRef, "CDU-1010");
    const miss = await new L.MockProvider().extractFieldEvent("XYZ-9999 excavation continuing", ctx());
    assert.equal(miss.event.activityRef, null);
  });

  test("people are recognised from the project roster", async () => {
    const { event } = await new L.MockProvider().extractFieldEvent("Rahul Verma confirmed the pour at CDU", ctx());
    assert.deepEqual(event.people, ["Rahul Verma"]);
  });

  test("relative and absolute dates both resolve", async () => {
    const p = new L.MockProvider();
    const at = ctx();
    assert.equal((await p.extractFieldEvent("Excavation today", at)).event.date, "2026-03-12");
    assert.equal((await p.extractFieldEvent("Excavation yesterday", at)).event.date, "2026-03-11");
    assert.equal((await p.extractFieldEvent("Excavation 3 days ago", at)).event.date, "2026-03-09");
    assert.equal((await p.extractFieldEvent("Excavation on 2026-04-01", at)).event.date, "2026-04-01");
    assert.equal((await p.extractFieldEvent("Excavation on 01/04/2026", at)).event.date, "2026-04-01", "day-first");
  });

  test("the mock provider is deterministic", async () => {
    const p = new L.MockProvider();
    const one = await p.extractFieldEvent(REPORT, ctx());
    const two = await p.extractFieldEvent(REPORT, ctx());
    assert.deepEqual(one.event, two.event);
    assert.deepEqual(one.event, (await new L.MockProvider().extractFieldEvent(REPORT, ctx())).event);
  });

  test("an empty report is refused rather than read", async () => {
    const res = await new L.MockProvider().extractFieldEvent("   ", ctx());
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /empty/);
  });
});

// ---------------------------------------------------------------- malformed output

describe("malformed provider output cannot corrupt anything", () => {
  test("coercion survives every shape a model might return", () => {
    for (const junk of [
      null, undefined, 42, "a string", [], [1, 2, 3], true,
      { work: 42, progress: "banana", people: "not an array" },
      { progress: 4200 }, { progress: -5 }, { date: "2026-02-31" }, { date: "soon" },
      { status: "exploded" }, { quantity: "NaN" }, { unit: {} },
      { people: [1, 2, { x: 1 }] }, { context: null },
    ]) {
      const ev = L.coerceFieldEvent(junk);
      assert.equal(typeof ev, "object");
      assert.ok(Array.isArray(ev.people) && Array.isArray(ev.context));
      assert.ok(ev.progress === null || (ev.progress >= 0 && ev.progress <= 100),
        `progress escaped range for ${JSON.stringify(junk)}`);
      assert.ok(ev.date === null || /^\d{4}-\d{2}-\d{2}$/.test(ev.date));
    }
  });

  test("out-of-range progress becomes null rather than being clamped", () => {
    // Clamping 4200 to 100 would hide that the model misread something.
    assert.equal(L.coerceFieldEvent({ progress: 4200 }).progress, null);
    assert.equal(L.coerceFieldEvent({ progress: 80 }).progress, 80);
    assert.equal(L.coerceFieldEvent({ progress: "80%" }).progress, 80);
  });

  test("an impossible date is refused, not rolled over", () => {
    assert.equal(L.coerceFieldEvent({ date: "2026-02-31" }).date, null);
    assert.equal(L.coerceFieldEvent({ date: "2026-02-28" }).date, "2026-02-28");
  });

  test("JSON is recovered from prose and from code fences", () => {
    assert.deepEqual(L.parseJsonObject('Sure! ```json\n{"work":"Excavation"}\n``` hope that helps'),
      { work: "Excavation" });
    assert.deepEqual(L.parseJsonObject('Here you go: {"work":"Excavation"}'), { work: "Excavation" });
    // Braces inside strings must not end the object early.
    assert.deepEqual(L.parseJsonObject('{"work":"a } b","progress":10}'), { work: "a } b", progress: 10 });
    assert.equal(L.parseJsonObject("no json here"), null);
    assert.equal(L.parseJsonObject('{"unclosed": '), null);
    assert.equal(L.parseJsonObject("[1,2,3]"), null, "an array is not the object we asked for");
  });

  test("a provider returning garbage still produces a usable, honest record", async () => {
    const w = world("bad1");
    const act = w.ownerActor();
    const res = await I.ingestReport(act, { text: REPORT }, {
      provider: garbageProvider("I'm afraid I can't do that"),
    });
    assert.ok(!("error" in res));
    assert.equal(res.extractionOk, false, "the failure is on the record");
    // And it fell back rather than storing nothing.
    assert.equal(res.provider, "garbage→mock");
    assert.equal(res.event.progress, 80, "the rule-based reading still worked");

    const stored = I.latestFieldEvent(res.reportId)!;
    assert.equal(stored.ok, 0);
    assert.match(stored.error ?? "", /not JSON/);
    assert.equal(stored.raw_output, "I'm afraid I can't do that", "kept verbatim for debugging");
  });

  test("a provider that throws does not take the request down", async () => {
    const w = world("bad2");
    const thrower = {
      name: "thrower", model: null,
      async extractFieldEvent(): Promise<never> { throw new Error("connection reset"); },
    } as import("../src/lib/llm/types.ts").LlmProvider;

    const res = await I.ingestReport(w.ownerActor(), { text: REPORT }, { provider: thrower });
    assert.ok(!("error" in res));
    assert.equal(res.extractionOk, false);
    assert.match(res.extractionError ?? "", /connection reset/);
  });

  test("a hostile payload lands as inert text, never as SQL or markup", async () => {
    const w = world("bad3");
    const nasty = `'; DROP TABLE tasks; -- <img src=x onerror=alert(1)>`;
    const res = await I.ingestReport(w.ownerActor(), { text: nasty }, {
      provider: garbageProvider(JSON.stringify({ work: nasty, location: nasty })),
    });
    assert.ok(!("error" in res));
    assert.equal(S.listActivities(w.project).length, 5, "the schedule is still there");
    assert.equal(I.latestFieldEvent(res.reportId)!.work, nasty, "stored as literal text");
  });

  test("the database refuses an out-of-range score even if scoring is wrong", () => {
    const w = world("bad4");
    const act = w.ownerActor();
    const runId = a.newId();
    D.db.prepare(`INSERT INTO progress_events (id, project_id, reported_at, source, review_state, created_at)
      VALUES (?, ?, ?, 'manual', 'pending', ?)`).run("r-bad4", w.project, Date.now(), Date.now());
    D.db.prepare(`INSERT INTO match_runs (id, project_id, report_id, provider, weights, outcome, created_at)
      VALUES (?, ?, 'r-bad4', 'x', '{}', 'review', ?)`).run(runId, w.project, Date.now());
    const activity = S.listActivities(w.project)[0];
    assert.throws(
      () => D.db.prepare(`INSERT INTO match_candidates (id, run_id, project_id, activity_id, rank, score, signals, created_at)
        VALUES (?, ?, ?, ?, 1, 1.5, '{}', ?)`).run(a.newId(), runId, w.project, activity.id, Date.now()),
      /between 0 and 1/
    );
    void act;
  });
});

// ---------------------------------------------------------------- signals

describe("individual signals", () => {
  test("token overlap ignores word order and length", () => {
    assert.ok(M.tokenOverlap("Foundation excavation", "Excavation of foundation") > 0.9);
    assert.equal(M.tokenOverlap("Foundation excavation", "Tank farm hydrotest"), 0);
  });

  test("place matching handles the loose way sites name things", () => {
    assert.equal(M.placeMatch("CDU", "CDU"), 1);
    assert.equal(M.placeMatch("CDU area", "CDU"), 0.9, "containment counts");
    assert.equal(M.placeMatch("CDU", "VDU"), 0);
    assert.equal(M.placeMatch(null, "CDU"), null, "nothing reported is not a mismatch");
    assert.equal(M.placeMatch("CDU", null), null);
  });

  test("date compatibility rewards the planned window and decays outside it", () => {
    const act = { start_date: "2026-03-01", due_date: "2026-03-20", actual_start: null, actual_finish: null };
    assert.equal(M.dateCompatibility("2026-03-10", act, 7), 1, "inside the window");
    assert.equal(M.dateCompatibility("2026-03-01", act, 7), 1, "on the boundary");
    const justAfter = M.dateCompatibility("2026-03-23", act, 7)!;
    assert.ok(justAfter > 0.5 && justAfter < 1, `3 days late should decay, got ${justAfter}`);
    const wayOff = M.dateCompatibility("2026-09-01", act, 7)!;
    assert.ok(wayOff < 0.2, `months off should be near zero, got ${wayOff}`);
    assert.equal(M.dateCompatibility(null, act, 7), null, "no date reported is not a mismatch");
  });

  test("cosine similarity is symmetric, bounded and self-identical", () => {
    const x = L.embedOne("Foundation excavation at CDU");
    const y = L.embedOne("CDU foundation excavation");
    const z = L.embedOne("Tank farm hydrotest");
    assert.ok(Math.abs(L.cosine(x, x) - 1) < 1e-6, "identical text is 1");
    assert.equal(L.cosine(x, y).toFixed(6), L.cosine(y, x).toFixed(6), "symmetric");
    assert.ok(L.cosine(x, y) > L.cosine(x, z), "related text beats unrelated");
    assert.ok(L.cosine(x, z) >= 0 && L.cosine(x, z) <= 1);
  });

  test("the lexical embedding is deterministic across calls", () => {
    assert.deepEqual([...L.embedOne("Foundation excavation")], [...L.embedOne("Foundation excavation")]);
  });

  test("a signal the report says nothing about is dropped, not scored zero", () => {
    const w = world("sig1");
    const activity = S.listActivities(w.project).find((x) => x.ref === "CDU-1010")!;
    const cfg = M.DEFAULT_CONFIG;
    const bare = { ...L.EMPTY_FIELD_EVENT, work: "Foundation excavation" };
    const scored = M.scoreActivity(
      { event: bare, reporterId: null, reporterScope: new Set(), recentWbs: [] },
      activity, cfg, L.embedOne("Foundation excavation"), L.embedOne(S.matchTextFor(activity))
    );
    assert.equal(scored.signals.location, undefined, "no location reported, so no location signal");
    assert.equal(scored.signals.date, undefined);
    assert.equal(scored.signals.assignment, undefined);
    assert.ok(scored.signals.semantic !== undefined && scored.signals.name !== undefined);
  });
});

// ---------------------------------------------------------------- matching

describe("candidate generation and ranking", () => {
  test("the worked example ranks the right activity first", async () => {
    const w = world("rank1");
    const res = await I.ingestReport(w.act(w.rahul), { text: REPORT, reportedBy: w.rahul.personId });
    assert.ok(!("error" in res));
    assert.ok(res.candidates.length >= 2, "several candidates, not one");
    assert.equal(res.candidates[0].activity.ref, "CDU-1010",
      `expected CDU Foundation Excavation first, got ${res.candidates.map((c) => `${c.activity.ref}@${c.score.toFixed(2)}`).join(", ")}`);
    // The near-misses are present but below it.
    const refs = res.candidates.map((c) => c.activity.ref);
    assert.ok(refs.includes("CDU-1020"), "the preparation activity is a real alternative");
    assert.ok(res.candidates[0].score > res.candidates[1].score, "strictly ranked");
  });

  test("location is what separates two identically-named activities", async () => {
    const w = world("rank2");
    // CDU-1010 and VDU-1010 have the same name bar the unit.
    const cdu = await I.ingestReport(w.ownerActor(), { text: "Foundation excavation 40% at CDU" });
    const vdu = await I.ingestReport(w.ownerActor(), { text: "Foundation excavation 40% at VDU" });
    assert.ok(!("error" in cdu) && !("error" in vdu));
    assert.equal(cdu.candidates[0].activity.ref, "CDU-1010");
    assert.equal(vdu.candidates[0].activity.ref, "VDU-1010");
  });

  test("a quoted activity ID outranks a better-reading name", async () => {
    const w = world("rank3");
    // The words point at the cable trench; the code points at the foundation.
    const res = await I.ingestReport(w.ownerActor(), { text: "CDU-1010 cable trench excavation 50%" });
    assert.ok(!("error" in res));
    assert.equal(res.candidates[0].activity.ref, "CDU-1010");
    assert.equal(res.candidates[0].signals.activityRef, 1);
  });

  test("candidates come back ranked, scored and explained", async () => {
    const w = world("rank4");
    const res = await I.ingestReport(w.act(w.rahul), { text: REPORT, reportedBy: w.rahul.personId });
    assert.ok(!("error" in res));
    res.candidates.forEach((c, i) => {
      assert.equal(c.rank, i + 1);
      assert.ok(c.score >= 0 && c.score <= 1);
      assert.ok(Object.keys(c.signals).length > 0, "every candidate carries its breakdown");
    });
    for (let i = 1; i < res.candidates.length; i++) {
      assert.ok(res.candidates[i - 1].score >= res.candidates[i].score, "descending");
    }
  });

  test("an unrelated report produces no candidate worth showing", async () => {
    const w = world("rank5");
    const res = await I.ingestReport(w.ownerActor(), {
      text: "Canteen menu updated and the printer needs toner",
    });
    assert.ok(!("error" in res));
    const top = res.candidates[0];
    assert.ok(!top || top.score < M.DEFAULT_CONFIG.autoLinkAt,
      `nonsense must not auto-link, got ${top?.score}`);
    assert.notEqual(res.outcome, "auto_link_proposed");
  });

  test("a project with no schedule yields no candidates rather than failing", async () => {
    const owner = mkUser("empty1");
    R.listRoles(owner);
    const project = (P.createProject(owner, { name: "Empty job", code: "EMP" }) as { id: string }).id;
    const res = await I.ingestReport(A.actorFor(project, owner, "empty1")!, { text: REPORT });
    assert.ok(!("error" in res));
    assert.equal(res.candidates.length, 0);
    assert.equal(res.outcome, "no_candidates");
  });

  test("ranking is stable across identical runs", async () => {
    const w = world("rank6");
    const one = await I.ingestReport(w.ownerActor(), { text: REPORT });
    const two = await I.ingestReport(w.ownerActor(), { text: REPORT });
    assert.ok(!("error" in one) && !("error" in two));
    assert.deepEqual(one.candidates.map((c) => c.activity.ref), two.candidates.map((c) => c.activity.ref));
    assert.deepEqual(
      one.candidates.map((c) => c.score.toFixed(6)),
      two.candidates.map((c) => c.score.toFixed(6)));
  });
});

// ---------------------------------------------------------------- confidence

describe("confidence and thresholds", () => {
  test("more corroborating signals means a higher score", async () => {
    const w = world("conf1");
    const vague = await I.ingestReport(w.ownerActor(), { text: "Some excavation happened" });
    const precise = await I.ingestReport(w.act(w.rahul), {
      text: "Foundation excavation 80% complete at CDU today",
      reportedBy: w.rahul.personId,
    });
    assert.ok(!("error" in vague) && !("error" in precise));
    assert.ok((precise.candidates[0]?.score ?? 0) > (vague.candidates[0]?.score ?? 0),
      "a specific report should be matched more confidently than a vague one");
  });

  test("weights are configurable and recorded on the run", async () => {
    const w = world("conf2");
    const cfg = { ...M.DEFAULT_CONFIG, weights: { ...M.DEFAULT_WEIGHTS, location: 20 } };
    const res = await I.ingestReport(w.ownerActor(), { text: "Excavation at VDU" }, { config: cfg });
    assert.ok(!("error" in res));
    const run = I.latestRun(res.reportId)!;
    assert.equal(JSON.parse(run.weights).location, 20, "the exact weighting is reproducible later");
    assert.equal(res.candidates[0].activity.ref, "VDU-1010", "location now dominates");
  });

  test("a malformed MATCH_WEIGHTS is ignored rather than fatal", () => {
    const before = process.env.MATCH_WEIGHTS;
    process.env.MATCH_WEIGHTS = "{not json";
    assert.deepEqual(M.loadConfig().weights, M.DEFAULT_WEIGHTS);
    process.env.MATCH_WEIGHTS = '{"location": 9, "nonsense": 3, "semantic": "high"}';
    const cfg = M.loadConfig();
    assert.equal(cfg.weights.location, 9, "valid keys applied");
    assert.equal(cfg.weights.semantic, M.DEFAULT_WEIGHTS.semantic, "invalid values ignored");
    if (before === undefined) delete process.env.MATCH_WEIGHTS; else process.env.MATCH_WEIGHTS = before;
  });

  test("below the threshold there is no proposal", () => {
    const cfg = { ...M.DEFAULT_CONFIG, autoLinkAt: 0.8 };
    const fake = (score: number) => ({ activity: {} as never, score, signals: {} });
    assert.equal(M.decideOutcome(fake(0.92), cfg), "auto_link_proposed");
    assert.equal(M.decideOutcome(fake(0.79), cfg), "review");
    assert.equal(M.decideOutcome(undefined, cfg), "no_candidates");
  });

  test("signal strengths read as words for the explanation panel", () => {
    assert.equal(M.describeSignal(0.95), "High");
    assert.equal(M.describeSignal(0.7), "Good");
    assert.equal(M.describeSignal(0.4), "Partial");
    assert.equal(M.describeSignal(0.1), "Weak");
    assert.equal(M.describeSignal(0), "None");
  });
});

// ---------------------------------------------------------------- the hard rule

describe("a score never changes the schedule", () => {
  test("even an auto-link leaves the activity untouched", async () => {
    const w = world("safe1");
    const act = w.ownerActor();
    const before = S.listActivities(w.project).find((x) => x.ref === "CDU-1010")!;

    const res = await I.ingestReport(act, {
      text: "CDU-1010 foundation excavation 80% complete at CDU today",
    }, { autoLink: true, config: { ...M.DEFAULT_CONFIG, autoLinkAt: 0.1 } });
    assert.ok(!("error" in res));
    assert.equal(res.autoLinked, true, "it did link");

    const after = S.listActivities(w.project).find((x) => x.ref === "CDU-1010")!;
    assert.equal(after.progress, before.progress, "progress did not move");
    assert.equal(after.status, before.status, "status did not move");
    // The link exists, and the claim is still waiting for a human.
    assert.equal(I.getReport(res.reportId, w.project)!.activity_id, before.id);
    assert.equal(I.getReport(res.reportId, w.project)!.review_state, "pending");
  });

  test("auto-link is off unless asked for", async () => {
    const w = world("safe2");
    const res = await I.ingestReport(w.ownerActor(), {
      text: "CDU-1010 foundation excavation 80% at CDU today",
    }, { config: { ...M.DEFAULT_CONFIG, autoLinkAt: 0.1 } });
    assert.ok(!("error" in res));
    assert.equal(res.outcome, "auto_link_proposed", "it would have");
    assert.equal(res.autoLinked, false, "but it did not");
    assert.equal(I.getReport(res.reportId, w.project)!.activity_id, null);
  });

  test("applying a claim is a separate, human act", async () => {
    const w = world("safe3");
    const act = w.ownerActor();
    const res = await I.ingestReport(act, { text: "Foundation excavation 80% complete at CDU today" });
    assert.ok(!("error" in res));
    const target = res.candidates[0].activity;
    assert.ok("ok" in I.decideMatch(act, res.reportId, "linked", target.id));

    // Linked, but the activity still has not moved.
    assert.equal(S.getActivity(target.id, w.project)!.progress, target.progress);
    // Only this does that.
    assert.ok("ok" in S.decideProgressEvent(act, res.reportId, "accepted"));
    assert.equal(S.getActivity(target.id, w.project)!.progress, 80);
  });
});

// ---------------------------------------------------------------- record keeping

describe("every attempt is kept", () => {
  test("re-running the matcher appends rather than overwrites", async () => {
    const w = world("keep1");
    const act = w.ownerActor();
    const first = await I.ingestReport(act, { text: REPORT });
    assert.ok(!("error" in first));
    const second = await I.matchReport(act, first.reportId, {
      config: { ...M.DEFAULT_CONFIG, weights: { ...M.DEFAULT_WEIGHTS, location: 15 } },
    });
    assert.ok(!("error" in second));

    assert.equal(I.runsFor(first.reportId).length, 2, "both runs survive");
    assert.equal(I.fieldEventsFor(first.reportId).length, 2, "both readings survive");
    assert.notEqual(first.runId, second.runId);
    assert.notEqual(JSON.parse(I.runsFor(first.reportId)[0].weights).location,
      JSON.parse(I.runsFor(first.reportId)[1].weights).location);
  });

  test("a run stores the provider, the model, the weights and the shortlist", async () => {
    const w = world("keep2");
    const res = await I.ingestReport(w.ownerActor(), { text: REPORT });
    assert.ok(!("error" in res));
    const run = I.latestRun(res.reportId)!;
    assert.equal(run.provider, "mock");
    assert.equal(run.model, "rules-v1");
    assert.equal(run.considered, 5, "every activity was scored");
    assert.ok(run.top_score! > 0);
    assert.ok(run.created_at > 0);

    const stored = I.candidatesOf(run.id);
    assert.equal(stored.length, res.candidates.length);
    assert.deepEqual(stored.map((c) => c.rank), stored.map((_, i) => i + 1));
    const signals = I.readSignals(stored[0].signals);
    assert.ok(Object.keys(signals).length > 0, "the breakdown is retrievable for the UI");
  });

  test("decisions are appended, so a reversal keeps its history", async () => {
    const w = world("keep3");
    const act = w.ownerActor();
    const res = await I.ingestReport(act, { text: REPORT });
    assert.ok(!("error" in res));
    const first = res.candidates[0].activity;
    const second = res.candidates[1].activity;

    assert.ok("ok" in I.decideMatch(act, res.reportId, "linked", first.id));
    assert.ok("ok" in I.decideMatch(act, res.reportId, "linked", second.id, "on reflection"));

    const decisions = I.decisionsFor(res.reportId);
    assert.equal(decisions.length, 2, "the first decision is still on the record");
    assert.equal(I.getReport(res.reportId, w.project)!.activity_id, second.id, "current link is the latest");
  });

  test("rejecting clears the link and says so", async () => {
    const w = world("keep4");
    const act = w.ownerActor();
    const res = await I.ingestReport(act, { text: REPORT });
    assert.ok(!("error" in res));
    I.decideMatch(act, res.reportId, "linked", res.candidates[0].activity.id);
    assert.ok("ok" in I.decideMatch(act, res.reportId, "rejected", null, "wrong unit"));
    assert.equal(I.getReport(res.reportId, w.project)!.activity_id, null);
    assert.equal(I.decisionsFor(res.reportId)[0].decision, "rejected");
  });

  test("a role without edit rights cannot decide a match", async () => {
    const w = world("keep5");
    const viewer = mkStaff(w.owner, w.project, "Viewer keep5", w.rahul.personId, "Viewer");
    const res = await I.ingestReport(w.ownerActor(), { text: REPORT });
    assert.ok(!("error" in res));
    assert.ok("error" in I.decideMatch(w.act(viewer), res.reportId, "linked", res.candidates[0].activity.id));
  });
});

// ---------------------------------------------------------------- isolation

describe("project isolation", () => {
  test("candidates only ever come from the report's own project", async () => {
    const w1 = world("iso1");
    const w2 = world("iso2");
    const res = await I.ingestReport(w1.ownerActor(), { text: REPORT });
    assert.ok(!("error" in res));
    const own = new Set(S.listActivities(w1.project).map((x) => x.id));
    for (const c of res.candidates) assert.ok(own.has(c.activity.id), "no cross-project candidate");
    assert.equal(I.getReport(res.reportId, w2.project), null, "invisible from the other project");
  });

  test("an outsider cannot match or decide another project's report", async () => {
    const w1 = world("iso3");
    const w2 = world("iso4");
    const res = await I.ingestReport(w1.ownerActor(), { text: REPORT });
    assert.ok(!("error" in res));
    assert.ok("error" in (await I.matchReport(w2.ownerActor(), res.reportId)));
    assert.ok("error" in I.decideMatch(w2.ownerActor(), res.reportId, "linked", res.candidates[0].activity.id));
  });

  test("linking to an activity from another project is refused", async () => {
    const w1 = world("iso5");
    const w2 = world("iso6");
    const res = await I.ingestReport(w1.ownerActor(), { text: REPORT });
    assert.ok(!("error" in res));
    const foreign = S.listActivities(w2.project)[0];
    assert.ok("error" in I.decideMatch(w1.ownerActor(), res.reportId, "linked", foreign.id));
  });
});
