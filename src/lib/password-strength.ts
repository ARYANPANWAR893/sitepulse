// No node imports — this file is shared with the client meter.

const COMMON = new Set([
  "12345678", "123456789", "1234567890", "password", "password1", "password123",
  "qwertyui", "qwerty123", "11111111", "00000000", "iloveyou", "sunshine",
  "princess", "football", "baseball", "welcome1", "admin123", "letmein1",
  "abc12345", "monkey12", "dragon12", "sitepulse",
]);

export type Strength = { score: 0 | 1 | 2 | 3 | 4; label: string; hint: string };

const LABELS = ["Very weak", "Weak", "Fair", "Strong", "Very strong"] as const;

/**
 * Advisory only. The server enforces length alone (NIST 800-63B: no composition
 * rules), so "12345678" is accepted — it just scores 0 and says so.
 */
export function strength(pw: string): Strength {
  if (!pw) return { score: 0, label: "", hint: "" };

  const lower = pw.toLowerCase();
  if (COMMON.has(lower)) {
    return { score: 0, label: LABELS[0], hint: "This is one of the most-guessed passwords." };
  }

  const classes =
    Number(/[a-z]/.test(pw)) + Number(/[A-Z]/.test(pw)) +
    Number(/[0-9]/.test(pw)) + Number(/[^A-Za-z0-9]/.test(pw));

  // Rough entropy: length x bits-per-char for the alphabet actually used.
  const alphabet = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/]
    .reduce((n, re, i) => (re.test(pw) ? n + [26, 26, 10, 33][i] : n), 0);
  let bits = pw.length * Math.log2(Math.max(alphabet, 2));

  if (/^(.)\1+$/.test(pw)) bits *= 0.25;                 // aaaaaaaa
  if (/^(?:0123|1234|2345|abcd|qwer)/i.test(pw)) bits *= 0.5; // keyboard runs

  const score = bits < 28 ? 0 : bits < 40 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;

  const hint =
    pw.length < 12 ? "Longer is stronger — aim for 12+ characters."
    : classes < 2 ? "Mixing letters, numbers or symbols helps."
    : score >= 3 ? "" : "Try a longer passphrase.";

  return { score: score as Strength["score"], label: LABELS[score], hint };
}
