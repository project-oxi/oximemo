/** Mirrors the backend's Unicode scalar count and letters/digits/-/_ rule. */
export function validSpaceName(raw: string): boolean {
  const name = raw.trim();
  const length = Array.from(name).length;
  return length >= 1 && length <= 64 && /^[\p{Alphabetic}\p{N}\-_]+$/u.test(name);
}
