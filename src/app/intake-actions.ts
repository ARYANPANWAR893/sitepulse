"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { allow } from "@/lib/auth";
import { actorFor, can, type Actor } from "@/lib/access";
import { ingestReport, matchReport, decideMatch } from "@/lib/intake";
import { decideProgressEvent } from "@/lib/schedule";

export type IntakeState = { error?: string; ok?: string; detail?: string[] };

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v : "";
};

async function actor(form: FormData): Promise<{ a: Actor } | { fail: IntakeState }> {
  const user = await currentUser();
  if (!user) redirect("/login");
  const projectId = str(form, "projectId");
  const a = projectId ? actorFor(projectId, user.id, user.name) : null;
  if (!a) return { fail: { error: "You don't have access to that project." } };
  return { a };
}

const refresh = () => {
  revalidatePath("/dashboard/reports");
  revalidatePath("/dashboard/schedule");
  revalidatePath("/dashboard");
};

/** Take a raw report, read it, and shortlist activities. Links nothing. */
export async function submitReport(_prev: IntakeState, form: FormData): Promise<IntakeState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;
  if (!allow(`report-in:${r.a.userId}`, 300, 60 * 60_000)) {
    return { error: "Too many reports at once. Try again shortly." };
  }

  const res = await ingestReport(r.a, { text: str(form, "text"), source: "manual" });
  if ("error" in res) return res;

  refresh();
  const detail: string[] = [];
  if (!res.extractionOk) {
    detail.push(`The reader fell back to rules — ${res.extractionError ?? "the model was unavailable"}.`);
  }
  detail.push(
    res.outcome === "no_candidates"
      ? "No activity in this schedule looked close enough to propose."
      : `${res.candidates.length} candidate${res.candidates.length === 1 ? "" : "s"}, best ${(res.candidates[0].score * 100).toFixed(0)}% — nothing is linked until you say so.`
  );
  return { ok: "Report read and matched.", detail };
}

/** Re-read and re-score an existing report. Appends a run; erases nothing. */
export async function rematchReport(_prev: IntakeState, form: FormData): Promise<IntakeState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;
  if (!allow(`report-rematch:${r.a.userId}`, 200, 60 * 60_000)) {
    return { error: "Too many re-runs at once. Try again shortly." };
  }

  const res = await matchReport(r.a, str(form, "reportId"));
  if ("error" in res) return res;

  refresh();
  return {
    ok: "Re-read and re-scored.",
    detail: ["The previous run is kept — a decision made against it stays readable."],
  };
}

/** A human's answer to the shortlist. */
export async function resolveMatch(_prev: IntakeState, form: FormData): Promise<IntakeState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;

  const decision = str(form, "decision");
  if (decision !== "linked" && decision !== "rejected" && decision !== "deferred") {
    return { error: "Choose link, reject or defer." };
  }

  const res = decideMatch(r.a, str(form, "reportId"), decision,
    str(form, "activityId") || null, str(form, "note") || undefined);
  if ("error" in res) return res;

  refresh();
  return {
    ok: decision === "linked" ? "Linked to the activity."
      : decision === "rejected" ? "Match rejected."
      : "Deferred.",
    detail: decision === "linked"
      ? ["The schedule has not changed. Accept the report below to apply its numbers."]
      : undefined,
  };
}

/**
 * Apply a linked report's claim to the activity.
 *
 * The separate, deliberate second act. Linking says the report is *about* this
 * activity; this says the activity has actually moved.
 */
export async function applyReport(_prev: IntakeState, form: FormData): Promise<IntakeState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;
  if (!can(r.a, "edit_tasks")) return { error: "Your role can't apply field reports." };

  const decision = str(form, "decision");
  if (decision !== "accepted" && decision !== "rejected") return { error: "Choose accept or reject." };

  const res = decideProgressEvent(r.a, str(form, "reportId"), decision, str(form, "note") || undefined);
  if ("error" in res) return res;

  refresh();
  return {
    ok: decision === "accepted" ? "Applied to the activity." : "Rejected — the activity is unchanged.",
  };
}
