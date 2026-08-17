import type {
  ClientEvidence,
  DiagnosticEvent,
  Report,
  ReportSummary,
  Site,
  SiteWithSummary,
  Verdict,
} from '@dwc/contracts';

/**
 * Thin typed wrapper over the API.
 *
 * Kept deliberately dumb — no caching, no state. The app owns state; this only
 * knows how to talk.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });

  if (response.status === 204) return undefined as T;

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const error =
      body !== null && typeof body === 'object' && 'error' in body
        ? (body.error as { code?: string; message?: string })
        : {};
    throw new ApiError(
      error.message ?? 'Something went wrong.',
      error.code ?? 'internal',
      response.status,
    );
  }

  return body as T;
}

export const api = {
  health: () => json<{ status: string; version: string; authMode: string }>('/api/health'),

  listSites: (include: 'active' | 'archived' | 'all' = 'active') =>
    json<{ sites: SiteWithSummary[] }>(`/api/sites?include=${include}`).then((r) => r.sites),

  createSite: (url: string, label?: string) =>
    json<{ site: Site }>('/api/sites', {
      method: 'POST',
      body: JSON.stringify({ url, ...(label === undefined ? {} : { label }) }),
    }).then((r) => r.site),

  updateSite: (id: string, patch: { label?: string; tags?: string[]; notes?: string | null }) =>
    json<{ site: Site }>(`/api/sites/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }).then((r) => r.site),

  archiveSite: (id: string) => json<{ site: Site }>(`/api/sites/${id}/archive`, { method: 'POST' }),
  restoreSite: (id: string) => json<{ site: Site }>(`/api/sites/${id}/restore`, { method: 'POST' }),
  deleteSite: (id: string) => json<void>(`/api/sites/${id}`, { method: 'DELETE' }),

  listReports: (siteId: string, include: 'active' | 'archived' | 'all' = 'active') =>
    json<{ reports: ReportSummary[] }>(`/api/sites/${siteId}/reports?include=${include}`).then(
      (r) => r.reports,
    ),

  getReport: (id: string) => json<{ report: Report }>(`/api/reports/${id}`).then((r) => r.report),
  archiveReport: (id: string) => json<{ ok: true }>(`/api/reports/${id}/archive`, { method: 'POST' }),
  restoreReport: (id: string) => json<{ ok: true }>(`/api/reports/${id}/restore`, { method: 'POST' }),
  deleteReport: (id: string) => json<void>(`/api/reports/${id}`, { method: 'DELETE' }),

  submitClientEvidence: (reportId: string, client: ClientEvidence) =>
    json<{ verdict: Verdict }>(`/api/reports/${reportId}/client-evidence`, {
      method: 'POST',
      body: JSON.stringify({ client }),
    }).then((r) => r.verdict),
};

/**
 * Run a diagnostic, yielding each streamed event as it arrives.
 *
 * An async generator rather than a callback so the caller can simply `for await`
 * and keep its own control flow readable.
 *
 * EventSource is not usable here because this is a POST with a body; the stream
 * is therefore parsed by hand, which is only a few lines for the subset of SSE
 * the server emits.
 */
export async function* streamDiagnostic(
  url: string,
  options: { siteId?: string; signal?: AbortSignal } = {},
): AsyncGenerator<DiagnosticEvent> {
  const response = await fetch('/api/diagnose', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, ...(options.siteId === undefined ? {} : { siteId: options.siteId }) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (!response.ok || response.body === null) {
    const body: unknown = await response.json().catch(() => null);
    const error =
      body !== null && typeof body === 'object' && 'error' in body
        ? (body.error as { code?: string; message?: string })
        : {};
    throw new ApiError(
      error.message ?? 'The check could not be started.',
      error.code ?? 'internal',
      response.status,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Events are separated by a blank line. Anything after the last separator is
    // a partial event and must stay in the buffer until the rest arrives.
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';

    for (const chunk of chunks) {
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (line === undefined) continue;
      try {
        yield JSON.parse(line.slice(6)) as DiagnosticEvent;
      } catch {
        // A malformed frame should not abort a diagnostic that is otherwise fine.
      }
    }
  }
}
