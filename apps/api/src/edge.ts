/**
 * Whether a request reached this server through a CDN edge.
 *
 * This exists for one reason: the browser measures its latency baseline against
 * this instance, and the route verdict subtracts that baseline from the reader's
 * time to the target. Behind a distributed frontend the reader's connection ends
 * at a point of presence near them and never reaches this machine, so the
 * baseline is short by however far the target actually is. The leftover would be
 * distance, and the report would hand it to the reader's provider.
 *
 * The engine refuses the subtraction when this is true. That refusal is only as
 * good as this detection, which is why the list is deliberate rather than broad.
 */

/**
 * Headers that only a distributed edge sets.
 *
 * `x-forwarded-for` is **deliberately absent**, and that is the whole design.
 * Caddy or nginx on the same box sets it while TLS still terminates on this
 * machine, so the baseline is perfectly good — and treating any proxy header as
 * an edge would disable the route verdict for the recommended deployment, which
 * is the one that makes the route measurable in the first place.
 */
const EDGE_HEADERS = [
  'cf-ray',
  'cf-connecting-ip',
  'true-client-ip',
  'x-amz-cf-id',
  'x-vercel-id',
  'fly-client-ip',
] as const;

/** The header that gave it away, or null. Named so the log can say which. */
export function edgeHeader(headers: Record<string, unknown>): string | null {
  for (const name of EDGE_HEADERS) {
    const value = headers[name];
    if (typeof value === 'string' && value.length > 0) return name;
    if (Array.isArray(value) && value.length > 0) return name;
  }
  return null;
}

export function detectEdge(headers: Record<string, unknown>): boolean {
  return edgeHeader(headers) !== null;
}
