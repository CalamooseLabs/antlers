// Minimal assertion helpers — ZERO external imports (no jsr:/npm:/@std), so the
// tests run offline in the nix sandbox and never touch the build's deno-cache FOD.

export function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}

export function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(msg ?? `expected ${e}, got ${a}`);
}

export function assertMatch(actual: string, re: RegExp, msg?: string): void {
  if (!re.test(actual)) throw new Error(msg ?? `${JSON.stringify(actual)} does not match ${re}`);
}

export function assertStringIncludes(actual: string, needle: string, msg?: string): void {
  if (!actual.includes(needle)) throw new Error(msg ?? `${JSON.stringify(actual)} does not include ${JSON.stringify(needle)}`);
}
