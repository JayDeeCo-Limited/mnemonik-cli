/**
 * Acceptances that cover another version's notice. 2026.09.2 changed one word
 * of 2026.09.1 ("editor" became "coding tool") and was withdrawn on 2026-09-28:
 * 2026.09.1 is current again, and a person who accepted 2026.09.2 accepted the
 * same notice. Never the reverse: the scanners released with 2026.09.2
 * (7.110.0-7.111.2) require it exactly and pause without it, so a 2026.09.1
 * acceptance must not install one.
 */
const COVERS: Readonly<Record<string, readonly string[]>> = { '2026.09.2': ['2026.09.1'] };

/** Whether consent accepted at `accepted` covers a scanner that requires `required`. */
export function disclosureCovers(accepted: string | null | undefined, required: string): boolean {
  if (!accepted) return false;
  return accepted === required || (COVERS[accepted]?.includes(required) ?? false);
}
