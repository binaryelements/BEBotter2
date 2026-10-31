const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----/, "private key"],
  [/sk-ant-[A-Za-z0-9_-]{8,}/, "token"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/, "token"],
  [/\bxox[abp]-[A-Za-z0-9-]{10,}/, "token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "token"],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/, "token"],
];
const ASSIGNED = /(password|passwd|secret|token)["']?[ \t]*[:=][ \t]*["']?(<[^>\n]*>|[^\s"',;]*)/gi;
const PLACEHOLDER = /^(<.*>|\*+|\[redacted\])$/i;

/** A short reason when the text looks like it holds a secret, otherwise undefined. */
export function findSecret(text: string): string | undefined {
  for (const [re, reason] of PATTERNS) if (re.test(text)) return reason;
  for (const m of text.matchAll(ASSIGNED)) {
    if (m[2] && !PLACEHOLDER.test(m[2])) return m[1].toLowerCase() === "token" ? "token" : "password";
  }
  return undefined;
}
