import "server-only";
import { inflateRawSync } from "node:zlib";

/**
 * Minimal .xlsx reader — no dependency.
 *
 * An xlsx is a ZIP of XML. We read the central directory (reliable sizes, unlike
 * local headers when a data descriptor is used), inflate the parts we need, and
 * pull cell text out of the sheet XML. Enough for a schedule export: shared and
 * inline strings, numbers, and serial dates. Not a general Excel engine — no
 * formulas, styles or merged cells.
 */

type Entry = { name: string; data: Buffer };

const EOCD = 0x06054b50, CEN = 0x02014b50;

function unzip(buf: Buffer): Map<string, Buffer> {
  // Locate the end-of-central-directory record, scanning back over any comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a valid .xlsx file (no ZIP directory).");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CEN) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    // Jump to the local header to find where the payload actually starts.
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);

    try {
      out.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    } catch {
      /* a part we can't inflate is a part we don't need */
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const unescapeXml = (s: string) =>
  s.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
   .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
   .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
   .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
   .replace(/&amp;/g, "&");

/** "BC12" → 54 (zero-based column index). */
function colIndex(ref: string): number {
  const m = /^([A-Z]+)/.exec(ref);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Excel serial → ISO date. The epoch is 1899-12-30 because Excel believes 1900
 * was a leap year; using that base absorbs the off-by-one.
 */
export function serialToDate(n: number): string | null {
  if (!Number.isFinite(n) || n < 1 || n > 2958465) return null;
  const ms = Date.UTC(1899, 11, 30) + Math.round(n) * 86400000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export type Sheet = { name: string; rows: string[][] };

function parseSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  for (const rowXml of xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []) {
    const cells: string[] = [];
    const cellRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let m: RegExpExecArray | null;
    while ((m = cellRe.exec(rowXml))) {
      const attrs = m[1] ?? "", body = m[2] ?? "";
      const refM = /r="([A-Z]+\d+)"/.exec(attrs);
      const at = refM ? colIndex(refM[1]) : cells.length;
      const type = /t="([^"]+)"/.exec(attrs)?.[1];

      let value = "";
      if (type === "inlineStr") {
        value = (body.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? [])
          .map((t) => unescapeXml(t.replace(/<[^>]+>/g, ""))).join("");
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (v !== undefined) {
          value = type === "s" ? (shared[Number(v)] ?? "") : unescapeXml(v);
        }
      }
      while (cells.length < at) cells.push("");   // honour sparse cells
      cells[at] = value;
    }
    rows.push(cells);
  }
  return rows;
}

export function readXlsx(buf: Buffer): Sheet[] {
  const files = unzip(buf);
  const dec = (n: string) => files.get(n)?.toString("utf8") ?? "";

  const shared = (dec("xl/sharedStrings.xml").match(/<si>[\s\S]*?<\/si>/g) ?? [])
    .map((si) => (si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? [])
      .map((t) => unescapeXml(t.replace(/<[^>]+>/g, ""))).join(""));

  // workbook.xml gives display names and r:id; the rels file maps r:id → part.
  const rels = new Map<string, string>();
  for (const r of dec("xl/_rels/workbook.xml.rels").match(/<Relationship[^>]*>/g) ?? []) {
    const id = /Id="([^"]+)"/.exec(r)?.[1];
    const target = /Target="([^"]+)"/.exec(r)?.[1];
    if (id && target) rels.set(id, target.replace(/^\/?(xl\/)?/, "xl/"));
  }

  const sheets: Sheet[] = [];
  for (const s of dec("xl/workbook.xml").match(/<sheet\b[^>]*>/g) ?? []) {
    const name = unescapeXml(/name="([^"]*)"/.exec(s)?.[1] ?? "Sheet");
    const rid = /r:id="([^"]+)"/.exec(s)?.[1];
    const part = rid ? rels.get(rid) : undefined;
    const xml = part ? dec(part) : "";
    if (xml) sheets.push({ name, rows: parseSheet(xml, shared) });
  }

  // Fall back to raw part order if the workbook part was unreadable.
  if (!sheets.length) {
    for (const [name, data] of files) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) {
        sheets.push({ name, rows: parseSheet(data.toString("utf8"), shared) });
      }
    }
  }
  return sheets;
}

/**
 * Which sheet actually holds the schedule? A real export opens on a cover page,
 * so pick the widest/longest grid rather than the first one.
 */
export function likeliestSheet(sheets: Sheet[]): number {
  let best = 0, bestScore = -1;
  sheets.forEach((s, i) => {
    const width = Math.max(0, ...s.rows.slice(0, 20).map((r) => r.length));
    const score = width * 2 + Math.min(s.rows.length, 500) / 10;
    if (s.rows.length > 1 && score > bestScore) { bestScore = score; best = i; }
  });
  return best;
}
