/**
 * A 128-bit random id as 32 lowercase hex chars. Uses `crypto.getRandomValues`,
 * which exists on plain-HTTP origins; `crypto.randomUUID` does not.
 */
export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
