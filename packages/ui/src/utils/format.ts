/**
 * Pure formatting helpers.
 *
 * Deliberately kept out of the component files. Components use decorators, and
 * Vite's Oxc transform cannot lower those — so anything importing a component
 * module fails to parse under Vitest. Pure logic lives here instead, where it is
 * testable in any environment and reusable without dragging in a custom element.
 */

/**
 * Relative time for recent entries, absolute for older ones.
 *
 * "3 min ago" is what you want while comparing a re-run against the previous
 * result; a date is what you want a fortnight later.
 */
export function formatWhen(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);

  // An unparseable timestamp must show as itself, never as "NaN days ago".
  if (Number.isNaN(seconds)) return iso;

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))} min ago`;
  if (seconds < 86_400) return `${String(Math.floor(seconds / 3600))} hr ago`;
  if (seconds < 604_800) return `${String(Math.floor(seconds / 86_400))} days ago`;

  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Human-readable byte sizes for evidence rows. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(Math.round(bytes))} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
