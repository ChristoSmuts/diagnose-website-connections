import { fetchSmallAsset } from './http.ts';

/**
 * The site's own favicon, fetched once and remembered.
 *
 * Fetched here rather than by the browser on purpose. A page requesting each
 * saved site's icon would announce the reader's whole list to those origins on
 * every load, and a third-party favicon service would put a company in the middle
 * of a tool that deliberately has none. The server already talks to these hosts
 * under the SSRF guard, so it is the one place this belongs.
 *
 * Only the well-known paths are tried. Discovering `<link rel="icon">` would mean
 * fetching and parsing the page a second time, and the overwhelming majority of
 * sites serve /favicon.ico regardless of what their markup declares.
 */

/** Well-known locations, best first. */
const CANDIDATES = ['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png'] as const;

/**
 * Small enough that a data URL in the site list is not a burden.
 *
 * A favicon that exceeds this is not a favicon — it is somebody's hero image at
 * the wrong URL, and inlining it into every sidebar render would cost more than
 * the icon is worth.
 */
const MAX_BYTES = 64 * 1024;

/** Image types worth rendering. SVG is excluded deliberately — see below. */
const ALLOWED: Record<string, string> = {
  'image/x-icon': 'image/x-icon',
  'image/vnd.microsoft.icon': 'image/vnd.microsoft.icon',
  'image/png': 'image/png',
  'image/gif': 'image/gif',
  'image/jpeg': 'image/jpeg',
  'image/webp': 'image/webp',
};

export interface IconProbeOptions {
  /** The site's origin. Paths and queries are ignored. */
  origin: string;
  timeoutMs: number;
  resolvers: readonly string[];
}

export async function probeIcon(options: IconProbeOptions): Promise<string | null> {
  let base: URL;
  try {
    base = new URL(options.origin);
  } catch {
    return null;
  }

  for (const path of CANDIDATES) {
    let asset;
    try {
      asset = await fetchSmallAsset({
        url: new URL(path, base.origin).toString(),
        maxBytes: MAX_BYTES,
        timeoutMs: options.timeoutMs,
        resolvers: options.resolvers,
      });
    } catch {
      // A site with no icon is the common case, not an error worth reporting.
      continue;
    }

    if (asset === null) continue;

    const dataUrl = toDataUrl(asset.contentType, asset.body);
    if (dataUrl !== null) return dataUrl;
  }

  return null;
}

/**
 * Wraps image bytes in a data URL, or refuses.
 *
 * The content type is checked against an allowlist rather than passed through.
 * A data URL is rendered by the browser as whatever type it declares, so echoing
 * an arbitrary server's content-type into one hands the choice to the site being
 * diagnosed. SVG is excluded for the same reason: it is a document format that
 * can carry script, and an icon is not worth that.
 *
 * Separated from the fetch so it can be tested without the network — this is the
 * security-relevant half, and the half worth being sure about.
 */
export function toDataUrl(contentType: string, body: Buffer): string | null {
  const type = ALLOWED[contentType.split(';')[0]!.trim().toLowerCase()];
  if (type === undefined) return null;
  if (body.length === 0) return null;

  return `data:${type};base64,${body.toString('base64')}`;
}
