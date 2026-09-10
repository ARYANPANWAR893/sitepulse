import "server-only";
import { redirect } from "next/navigation";
import { currentUser } from "./session.ts";
import { listProjects, getProject, listMembers, type Project } from "./people.ts";
import { db } from "./db.ts";
import { actorFor, type Actor } from "./access.ts";

export type Ctx = {
  user: { id: string; name: string; email: string };
  projects: Project[];
  project: Project | null;
  actor: Actor | null;
};

/**
 * Every dashboard page resolves through here, so "which project am I looking
 * at, and what am I allowed to do in it" is answered one way, once.
 *
 * A project id in the URL is never trusted on its own — it has to survive
 * either an owner-scoped lookup or a membership lookup.
 */
export async function dashContext(wanted?: string): Promise<Ctx> {
  const session = await currentUser();
  if (!session) redirect("/login");

  const owned = listProjects(session.id);

  // Projects this user can reach as a linked member rather than as the owner.
  const joined = db.prepare(`
    SELECT DISTINCT pr.* FROM projects pr
    JOIN memberships m ON m.project_id = pr.id
    JOIN people p ON p.id = m.person_id
    WHERE p.user_id = ? AND pr.owner_id != ?
    ORDER BY pr.created_at`).all(session.id, session.id) as Project[];

  const projects = [...owned, ...joined];
  const project =
    (wanted ? (getProject(wanted, session.id) ?? joined.find((p) => p.id === wanted) ?? null) : null) ??
    projects[0] ?? null;

  const actor = project ? actorFor(project.id, session.id, session.name) : null;

  return {
    user: { id: session.id, name: session.name, email: session.email },
    projects, project, actor,
  };
}

export const membersOf = (projectId: string) => listMembers(projectId);
