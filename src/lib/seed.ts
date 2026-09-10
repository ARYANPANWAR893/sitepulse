import "server-only";
import { hashPassword, uq, newId } from "./auth.ts";
import { createProject, addMember, setMemberRole, linkPersonToUser } from "./people.ts";
import { listRoles, roleByName } from "./roles.ts";
import { actorFor } from "./access.ts";
import { commitSchedule } from "./schedule.ts";
import { db, now } from "./db.ts";

/**
 * Demo seed for an ephemeral deployment.
 *
 * On a host with no persistent disk — Vercel, say — the database lives in /tmp,
 * which is per-instance and wiped on cold start. That leaves a login page and no
 * account behind it: signup needs an email OTP, and without a mail key the code
 * only reaches the server log. This makes every cold start come up usable.
 *
 * Inert unless BOTH `DEMO_EMAIL` and `DEMO_PASSWORD` are set. There is
 * deliberately no default password: a known credential on a public URL would be
 * an open door, not a convenience.
 *
 * ponytail: fine for a demo host. On a real deployment with a persistent disk,
 * unset the two variables and this never runs.
 */

let started: Promise<void> | null = null;

export function ensureDemoSeed(): Promise<void> {
  // Memoised per instance: every request renders the root layout, and only the
  // first one on a cold start should do any of this.
  started ??= seed().catch((e) => {
    console.error("[seed] demo seed failed:", (e as Error).message);
  });
  return started;
}

async function seed(): Promise<void> {
  const email = process.env.DEMO_EMAIL?.trim().toLowerCase();
  const password = process.env.DEMO_PASSWORD;
  if (!email || !password || password.length < 8) return;

  if (uq.byEmail.get(email)) return;              // already seeded, or a real account

  const userId = newId();
  uq.insert.run(userId, process.env.DEMO_NAME || "Demo Planner", email, null,
    await hashPassword(password), 1, 1, null, now());

  listRoles(userId);                              // seeds the role presets
  const project = createProject(userId, {
    name: "Duliajan Pipeline Package 3",
    code: "OILP",
    client: "Oil India Limited",
    location: "Duliajan, Assam",
    startDate: "2026-01-05",
    plannedCompletion: "2026-06-30",
    description: "Demo project — 18in trunkline, KP0 to KP12.",
  });
  if ("error" in project) throw new Error(project.error);

  // A three-level chain, so delegation and scope have something to act on.
  const add = (name: string, parent: string | null, role: string, discipline?: string) => {
    const res = addMember(userId, project.id, { name, parentId: parent, discipline });
    if ("error" in res) throw new Error(`${name}: ${res.error}`);
    setMemberRole(project.id, res.id, roleByName(userId, role)!.id);
    return res.id;
  };
  const amit = add("Amit Sharma", null, "Manager", "Construction");
  const rahul = add("Rahul Verma", amit, "Supervisor", "Civil");
  const vivek = add("Vivek Rao", amit, "Supervisor", "Piping");
  add("Karan Singh", rahul, "Contributor", "Civil");
  add("S. Ekka", vivek, "Contributor", "Piping");

  const actor = actorFor(project.id, userId, "Demo Planner");
  if (!actor) throw new Error("seeded project has no actor");

  const res = commitSchedule(actor, SCHEDULE, { filename: "duliajan-pkg3-wk12.csv", sheetName: "TASK" });
  if ("error" in res) throw new Error(res.error);

  console.log(`[seed] demo ready: ${email} · ${res.created} activities, ${res.relationsMade} logic links`);
}

/** A small but real-shaped P6 export: WBS, baselines, logic, mixed progress. */
const SCHEDULE: string[][] = [
  ["Activity ID", "Activity Name", "WBS", "WBS Path", "Discipline", "Location",
   "Planned Start", "Planned Finish", "Baseline Finish", "Duration", "Predecessors",
   "% Complete", "Status", "Responsible Person"],
  ["OIL-1010", "Right of way clearing KP0-KP4", "1.1", "Package 3 > Civil > Enabling", "Civil", "KP0-KP4",
   "2026-01-05", "2026-01-16", "2026-01-16", "11", "", "100", "Complete", "Rahul Verma"],
  ["OIL-1020", "Trench excavation KP0-KP4", "1.1.1", "Package 3 > Civil > Earthworks", "Civil", "KP0-KP4",
   "2026-01-19", "2026-02-06", "2026-02-03", "18", "OIL-1010", "72", "In Progress", "Rahul Verma"],
  ["OIL-1030", "Pipe stringing 18in KP0-KP4", "1.2", "Package 3 > Piping > Laying", "Piping", "KP0-KP4",
   "2026-02-09", "2026-02-27", "2026-02-25", "18", "OIL-1020FS+2", "35", "In Progress", "Vivek Rao"],
  ["OIL-1040", "Field welding and NDT KP0-KP4", "1.2.1", "Package 3 > Piping > Welding", "Piping", "KP0-KP4",
   "2026-03-02", "2026-03-27", "2026-03-24", "25", "OIL-1030", "8", "In Progress", "S. Ekka"],
  ["OIL-1050", "Hydrotest section 1", "1.3", "Package 3 > Piping > Testing", "Piping", "KP0-KP4",
   "2026-03-30", "2026-04-07", "2026-04-03", "8", "OIL-1040", "0", "Not Started", ""],
  ["OIL-1060", "Cathodic protection install", "1.4", "Package 3 > Electrical", "Electrical", "KP0-KP4",
   "2026-03-16", "2026-04-03", "2026-04-03", "18", "OIL-1030", "0", "Not Started", "Amit Sharma"],
  ["OIL-1070", "Backfill and restoration KP0-KP4", "1.1.2", "Package 3 > Civil > Earthworks", "Civil", "KP0-KP4",
   "2026-04-08", "2026-04-24", "2026-04-21", "16", "OIL-1050", "0", "Not Started", "Karan Singh"],
  ["OIL-2010", "Trench excavation KP4-KP12", "2.1.1", "Package 3 > Civil > Earthworks", "Civil", "KP4-KP12",
   "2026-02-09", "2026-03-13", "2026-03-10", "32", "OIL-1010", "18", "In Progress", "Rahul Verma"],
  ["OIL-2020", "Pipe stringing 18in KP4-KP12", "2.2", "Package 3 > Piping > Laying", "Piping", "KP4-KP12",
   "2026-03-16", "2026-04-17", "2026-04-14", "32", "OIL-2010", "0", "Not Started", "Vivek Rao"],
  ["OIL-2030", "Tie-in and commissioning", "2.3", "Package 3 > Piping > Commissioning", "Piping", "KP12",
   "2026-04-20", "2026-05-08", "2026-05-05", "18", "OIL-2020, OIL-1070", "0", "Not Started", ""],
];

// Ensure the DB module is initialised before anything above touches it.
void db;
