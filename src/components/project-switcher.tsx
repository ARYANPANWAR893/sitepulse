"use client";

/**
 * Shown wherever a page needs a project but none is selected. The button asks
 * the sidebar's dialog to open rather than duplicating the creation form, so
 * there stays exactly one place a project can be created.
 */
export function NoProject() {
  return (
    <div className="rounded-xl border border-dashed border-line-strong px-4 py-14 text-center">
      <p className="font-display text-xl font-bold">No project yet.</p>
      <p className="mx-auto mt-1 max-w-[46ch] text-[0.88rem] text-ink-soft">
        Everything — people, hierarchy and tasks — lives inside a project.
      </p>
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent("sitepulse:new-project"))}
        className="btn btn-primary mt-5"
      >
        + New project
      </button>
    </div>
  );
}
