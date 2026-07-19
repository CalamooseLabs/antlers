// Tiny local assertions — the app forbids external imports (jsr:@std/assert included),
// so tests use these instead. ZERO external imports.

export function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}

export function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(msg ?? `expected ${e} but got ${a}`);
}

export function assertStringIncludes(haystack: string, needle: string, msg?: string): void {
  if (!haystack.includes(needle)) throw new Error(msg ?? `expected string to include ${JSON.stringify(needle)}`);
}

export function assertThrows(fn: () => unknown, msg?: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(msg ?? "expected function to throw");
}

export async function assertRejects(fn: () => Promise<unknown>, msg?: string): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(msg ?? "expected promise to reject");
}
