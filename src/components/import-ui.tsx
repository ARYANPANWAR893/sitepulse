"use client";

import { useRef, useState } from "react";
import type { ImportFeedback, RowVerdict, SheetInfo } from "@/lib/import-types";

/**
 * The chrome shared by the Tasks and People importers.
 *
 * Both panels are the same four beats — choose a source, pick a sheet, map the
 * columns, review the rows — and were previously two near-identical copies, so
 * every fix had to be made twice. Only the preview table differs, and that
 * stays in each panel.
 */

// ---------------------------------------------------------------- feedback

export function Note({ s }: { s: ImportFeedback }) {
  if (!s.error && !s.ok) return null;
  const bad = !!s.error;
  return (
    <div
      role={bad ? "alert" : "status"}
      className={`rounded-lg px-3 py-2 text-[0.85rem] ${
        bad ? "bg-rust-soft text-rust" : "bg-accent-soft text-accent-strong"
      }`}
    >
      {s.error ?? s.ok}
      {s.detail?.length ? (
        <ul className="mt-1.5 space-y-0.5 font-mono text-[0.72rem] opacity-90">
          {s.detail.map((d) => (
            <li key={d}>· {d}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function Spinner() {
  return <span className="sp-spinner" aria-hidden />;
}

// ---------------------------------------------------------------- shell

const STEPS = ["Source", "Map", "Review"] as const;

/** Panel frame: title, step rail, close. `step` is 0-based. */
export function ImportShell({
  title,
  step,
  onClose,
  children,
}: {
  title: string;
  step: number;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="w-full space-y-4 overflow-hidden rounded-xl border border-line bg-paper-raised">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-paper-sunk/60 px-5 py-3">
        <div className="flex items-center gap-3">
          <h3 className="font-display text-lg font-bold tracking-wide">{title}</h3>
          <ol className="hidden items-center gap-1.5 sm:flex">
            {STEPS.map((s, i) => (
              <li key={s} className="flex items-center gap-1.5">
                {i > 0 && <span aria-hidden className="h-px w-4 bg-line-strong" />}
                <span
                  aria-current={i === step ? "step" : undefined}
                  className={`rounded-full px-2 py-0.5 font-mono text-[0.68rem] tracking-wider uppercase transition-colors ${
                    i === step
                      ? "bg-accent text-on-accent"
                      : i < step
                        ? "text-accent-strong"
                        : "text-ink-soft/60"
                  }`}
                >
                  {i < step ? "✓ " : `${i + 1} `}
                  {s}
                </span>
              </li>
            ))}
          </ol>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="font-mono text-[0.76rem] text-ink-soft transition-colors hover:text-ink"
        >
          Close
        </button>
      </div>
      <div className="space-y-4 px-5 pb-5">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------- source

/** Upload / paste toggle. */
export function SourceTabs({
  mode,
  onMode,
}: {
  mode: "file" | "paste";
  onMode: (m: "file" | "paste") => void;
}) {
  return (
    <div className="flex gap-1 rounded-lg bg-paper-sunk p-1">
      {(["file", "paste"] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onMode(m)}
          className={`flex-1 rounded-md px-3 py-1.5 font-mono text-[0.76rem] transition-colors ${
            mode === m
              ? "bg-paper-raised text-accent-strong shadow-[var(--shadow-raised)]"
              : "text-ink-soft hover:text-ink"
          }`}
        >
          {m === "file" ? "Upload .xlsx / .csv" : "Paste rows"}
        </button>
      ))}
    </div>
  );
}

const KB = 1024;
const fileSize = (n: number) =>
  n < KB ? `${n} B` : n < KB * KB ? `${(n / KB).toFixed(0)} KB` : `${(n / KB / KB).toFixed(1)} MB`;

/**
 * Drop zone wrapping a real <input type=file>, so the form still submits the
 * file the ordinary way and keyboard users get the native picker. Dropping
 * assigns to input.files via DataTransfer — the only way to hand a dropped
 * file to a form control without uploading it separately.
 */
export function FileDrop({ name = "file" }: { name?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [picked, setPicked] = useState<{ name: string; size: number } | null>(null);

  const take = (files: FileList | null) => {
    const f = files?.[0];
    setPicked(f ? { name: f.name, size: f.size } : null);
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const input = ref.current;
        if (!input || !e.dataTransfer.files.length) return;
        const dt = new DataTransfer();
        dt.items.add(e.dataTransfer.files[0]);
        input.files = dt.files;
        take(dt.files);
      }}
      onClick={() => ref.current?.click()}
      className={`cursor-pointer rounded-xl border border-dashed px-4 py-7 text-center transition-colors ${
        over ? "border-accent bg-accent-soft" : "border-line-strong bg-paper hover:border-accent"
      }`}
    >
      <input
        ref={ref}
        name={name}
        type="file"
        accept=".csv,.xlsx,text/csv"
        onChange={(e) => take(e.target.files)}
        className="sr-only"
      />
      {picked ? (
        <>
          <p className="font-mono text-[0.85rem] break-all text-ink">{picked.name}</p>
          <p className="mt-1 font-mono text-[0.72rem] text-ink-soft">
            {fileSize(picked.size)} · click to choose a different file
          </p>
        </>
      ) : (
        <>
          <p className="text-[0.88rem] text-ink">
            Drop a file here, or <span className="text-accent-strong underline">browse</span>
          </p>
          <p className="mt-1 font-mono text-[0.72rem] text-ink-soft">
            .xlsx or .csv · a Primavera export works as-is
          </p>
        </>
      )}
    </div>
  );
}

/** Filename / sheet / row-count strip above the review step. */
export function SourceBar({
  filename,
  sheet,
  total,
  noun,
  onReset,
}: {
  filename?: string | null;
  sheet?: SheetInfo;
  total: number;
  noun: string;
  onReset: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-paper-sunk/60 px-3 py-2 font-mono text-[0.74rem] text-ink-soft">
      <span className="text-ink">{filename || "pasted rows"}</span>
      {sheet && <span>· sheet {sheet.name}</span>}
      <span>
        · {total} {noun}
      </span>
      <button
        type="button"
        onClick={onReset}
        className="ml-auto text-accent-strong transition-colors hover:text-ink"
      >
        Start over
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- sheet

export function SheetPicker({
  sheets,
  current,
}: {
  sheets: SheetInfo[] | undefined;
  current: number | undefined;
}) {
  if ((sheets?.length ?? 0) <= 1) {
    return <input type="hidden" name="sheetIndex" value={current ?? 0} />;
  }
  return (
    <div>
      <p className="mb-2 font-mono text-[0.66rem] tracking-wider text-ink-soft uppercase">Sheet</p>
      <div className="flex flex-wrap gap-2">
        {sheets!.map((sh) => (
          <label
            key={sh.index}
            className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[0.8rem] transition-colors ${
              sh.index === current
                ? "border-accent bg-accent-soft text-accent-strong"
                : "border-line-strong text-ink-soft hover:border-accent"
            }`}
          >
            <input
              type="radio"
              name="sheetIndex"
              value={sh.index}
              defaultChecked={sh.index === current}
              className="sr-only"
            />
            {sh.name}
            <span className="font-mono text-[0.68rem] opacity-70">
              {sh.rows}×{sh.columns}
            </span>
          </label>
        ))}
      </div>
      <p className="mt-1.5 text-[0.74rem] text-ink-soft">
        Picked the largest grid automatically — change it if the schedule lives elsewhere.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- mapping

/**
 * Column mapping, collapsed by default.
 *
 * A P6 export carries 30+ columns and only a handful matter, so the unmapped
 * ones are noise once auto-detection has run. The summary line says how many
 * were matched; open it only when one is wrong.
 */
export function MappingGrid({
  header,
  mapping,
  fields,
}: {
  header: string[] | undefined;
  mapping: Record<number, string> | undefined;
  fields: readonly (readonly [string, string])[];
}) {
  const [showAll, setShowAll] = useState(false);
  if (!header?.length) return null;

  const mapped = header.filter((_, i) => mapping?.[i]).length;
  const shown = header.map((h, i) => ({ h, i })).filter((c) => showAll || mapping?.[c.i]);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="font-mono text-[0.66rem] tracking-wider text-ink-soft uppercase">
          Column mapping
        </p>
        <span className="font-mono text-[0.72rem] text-accent-strong">
          {mapped} of {header.length} matched
        </span>
        {mapped < header.length && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="ml-auto font-mono text-[0.72rem] text-ink-soft transition-colors hover:text-accent-strong"
          >
            {showAll ? "Hide unmapped" : `Show all ${header.length} columns`}
          </button>
        )}
      </div>
      <div className="grid max-h-[16rem] gap-1.5 overflow-auto rounded-lg border border-line p-2 sm:grid-cols-2">
        {shown.map(({ h, i }) => (
          <label
            key={i}
            className={`flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors ${
              mapping?.[i] ? "bg-accent-soft/40" : ""
            }`}
          >
            <span
              className={`min-w-0 flex-1 truncate font-mono text-[0.74rem] ${
                mapping?.[i] ? "text-ink" : "text-ink-soft"
              }`}
              title={h}
            >
              {h || <em>column {i + 1}</em>}
            </span>
            <select
              name={`map:${i}`}
              defaultValue={mapping?.[i] ?? ""}
              aria-label={`Map column ${h || i + 1}`}
              className="rounded-md border border-line-strong bg-paper px-1.5 py-1 text-[0.76rem] text-ink outline-none focus:border-accent"
            >
              {fields.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {/* Hidden columns still need their value posted, or re-checking would
          silently drop a mapping the user never touched. */}
      {!showAll &&
        header.map((_, i) =>
          mapping?.[i] ? null : (
            <input key={i} type="hidden" name={`map:${i}`} value={mapping?.[i] ?? ""} />
          )
        )}
    </div>
  );
}

// ---------------------------------------------------------------- review

const CHIP = "rounded-full px-2.5 py-1 font-mono text-[0.72rem]";

export function CountChips({
  counts,
  noun,
  filter,
  onFilter,
}: {
  counts: Record<string, number>;
  noun: string;
  filter: boolean;
  onFilter: (v: boolean) => void;
}) {
  const bad = (counts.warning ?? 0) + (counts.error ?? 0);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={`${CHIP} bg-paper-sunk text-ink`}>
        {counts.total ?? 0} {noun}
      </span>
      <span className={`${CHIP} bg-accent-soft text-accent-strong`}>
        {counts.valid ?? 0} valid
      </span>
      {(counts.warning ?? 0) > 0 && (
        <span className={`${CHIP} bg-amber-soft text-amber`}>{counts.warning} warnings</span>
      )}
      {(counts.error ?? 0) > 0 && (
        <span className={`${CHIP} bg-rust-soft text-rust`}>{counts.error} errors</span>
      )}
      {bad > 0 && (
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 font-mono text-[0.74rem] text-ink-soft">
          <input
            type="checkbox"
            checked={filter}
            onChange={(e) => onFilter(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          Only show problems
        </label>
      )}
    </div>
  );
}

const VERDICT: Record<RowVerdict, string> = {
  valid: "bg-accent-soft text-accent-strong",
  warning: "bg-amber-soft text-amber",
  error: "bg-rust-soft text-rust",
};

export function Verdict({ v, messages }: { v: RowVerdict; messages: string[] }) {
  return (
    <>
      <span
        className={`inline-block rounded-full px-2 py-0.5 font-mono text-[0.68rem] tracking-wide ${VERDICT[v]}`}
      >
        {v}
      </span>
      {messages.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-[0.72rem] text-ink-soft">
          {messages.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Row tint so an error is findable without reading the verdict column. */
export const rowTone = (v: RowVerdict) =>
  v === "error" ? "bg-rust-soft/30" : v === "warning" ? "bg-amber-soft/25" : "";

export const tableWrap =
  "overflow-auto rounded-lg border border-line";
export const headRow =
  "text-left font-mono text-[0.68rem] tracking-wider text-ink-soft uppercase";
