// HTTP helpers: JSON responses and a size-capped JSON body reader.

export function json(obj: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

// Read and JSON-parse a request body, refusing oversized payloads so an
// unauthenticated POST can't exhaust memory. The body is consumed once; callers
// that want to tolerate parse failures should `.catch(() => ({}))`.
export async function readJsonLimited(
  req: Request,
  limit = 1_000_000,
): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) throw new Error("payload too large");
  const ab = await req.arrayBuffer();
  if (ab.byteLength > limit) throw new Error("payload too large");
  if (ab.byteLength === 0) return {};
  return JSON.parse(new TextDecoder().decode(ab));
}
