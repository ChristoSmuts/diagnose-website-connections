import type { Culprit, ReportSummary, SiteWithSummary } from '@dwc/contracts';
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../styles/shared.js';
import { formatWhen } from '../utils/format.js';
import './dwc-icon.js';

const CULPRIT_TONE: Record<Culprit, string> = {
  healthy: 'ok',
  server: 'bad',
  'user-connection': 'warn',
  'network-path': 'warn',
  mixed: 'bad',
  unreachable: 'bad',
  inconclusive: 'unknown',
};

/**
 * A stable hue per site, so its monogram is the same colour every time.
 *
 * A plain sum of character codes rather than anything cryptographic: this only
 * has to be deterministic and reasonably spread, and a site whose colour changed
 * between visits would be worse than no colour at all.
 */
function hueFor(value: string): number {
  let total = 0;
  for (let i = 0; i < value.length; i += 1) total = (total + value.charCodeAt(i) * 17) % 360;
  return total;
}

/** First letter or digit of the label, for the monogram. */
function initialFor(label: string): string {
  return /[a-z0-9]/i.exec(label)?.[0] ?? '?';
}

/**
 * Sites, with their report history nested beneath.
 *
 * The mental model is "my sites, and what happened to them over time", so sites
 * are parents and reports are children rather than two flat lists. One component
 * serves both the desktop sidebar and the mobile drawer — same information
 * architecture, different container, no divergent behaviour to keep in sync.
 */
@customElement('dwc-nav-tree')
export class DwcNavTree extends LitElement {
  static override styles = [
    ...sharedStyles,
    css`
      :host {
        display: block;
      }

      ul {
        list-style: none;
        margin: 0;
        padding: 0;
      }

      .site-row {
        display: flex;
        align-items: center;
        gap: var(--dwc-space-1);
        border-radius: var(--dwc-radius);
      }
      .site-row:hover {
        background: var(--dwc-surface-hover);
      }
      .site-row[data-selected='true'] {
        background: var(--dwc-brand-subtle);
      }

      .disclosure {
        display: grid;
        place-items: center;
        width: 1.5rem;
        height: 2.25rem;
        flex: none;
        border: none;
        background: none;
        color: var(--dwc-text-subtle);
        cursor: pointer;
        --dwc-icon-size: 0.875rem;
      }
      .disclosure dwc-icon {
        transition: transform var(--dwc-duration-fast) var(--dwc-ease);
      }
      .disclosure[aria-expanded='true'] dwc-icon {
        transform: rotate(90deg);
      }

      .site-button {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: var(--dwc-space-2);
        min-height: 2.25rem;
        padding: var(--dwc-space-1) var(--dwc-space-2) var(--dwc-space-1) 0;
        border: none;
        background: none;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }

      .status-dot {
        width: 0.5rem;
        height: 0.5rem;
        flex: none;
        border-radius: var(--dwc-radius-full);
        background: var(--dot);
      }

      /*
       * The site's own favicon, with a monogram behind it.
       *
       * The monogram is not a placeholder for a slow image — it is the answer for
       * every site that has no favicon at all, which is a good many of them. Both
       * are the same size and shape so the rail does not jump between the two.
       */
      .favicon {
        position: relative;
        width: 1.25rem;
        height: 1.25rem;
        flex: none;
      }

      /*
       * The clip lives here rather than on .favicon, and that is the whole point
       * of this element existing.
       *
       * A remote favicon can be any shape, so the artwork has to be clipped to a
       * rounded square. The health dot below deliberately overhangs the corner.
       * Both rules were once on .favicon, where the clip won: it sliced the flat
       * right and bottom off the dot along with its entire ring, and the result
       * read as an oval leaning right. One element cannot both clip its contents
       * and let a child hang outside, so they are now two.
       */
      .favicon-art {
        display: grid;
        place-items: center;
        width: 100%;
        height: 100%;
        border-radius: var(--dwc-radius-sm);
        overflow: hidden;
      }

      .favicon img {
        width: 100%;
        height: 100%;
        object-fit: contain;
      }

      .monogram {
        width: 100%;
        height: 100%;
        display: grid;
        place-items: center;
        border-radius: var(--dwc-radius-sm);
        /* Hue from the hostname, so a site keeps the same colour every time and
           two sites in a list are told apart at a glance. */
        background: oklch(92% 0.05 var(--hue));
        color: oklch(38% 0.11 var(--hue));
        font-size: 0.625rem;
        font-weight: var(--dwc-weight-semibold);
        line-height: 1;
        text-transform: uppercase;
      }

      /*
       * The health dot rides the corner of the icon rather than taking its own
       * column, so the row keeps its width and the two read as one object.
       *
       * It keeps the base 0.5rem rather than the 0.4375rem it once had: seven
       * pixels centred inside a 1.5px ring lands every edge on a half pixel, and
       * fractional-DPR displays round those inconsistently — the circle comes out
       * heavier on one side even with nothing clipping it.
       */
      .favicon .status-dot {
        position: absolute;
        right: -1px;
        bottom: -1px;
        box-shadow: 0 0 0 1.5px var(--dwc-surface-raised);
      }

      .name {
        flex: 1;
        min-width: 0;
        font-size: var(--dwc-text-sm);
        font-weight: var(--dwc-weight-medium);
        color: var(--dwc-text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .count {
        font-size: var(--dwc-text-xs);
        color: var(--dwc-text-subtle);
        font-variant-numeric: tabular-nums;
      }

      /*
       * The report count needs more weight once its row is selected.
       *
       * The subtle text token is tuned against the sidebar's own surface, not against
       * the brand wash a selected row paints underneath it: that pairing measures
       * 4.31:1 in light and 4.48:1 in dark, both just under the 4.5:1 that WCAG AA
       * asks for. Muted clears it comfortably in both — 5.6:1 and 7.0:1.
       *
       * Latent until the tree began following the current report, because before
       * that a row was only ever selected by clicking one, and the accessibility
       * specs never clicked.
       */
      .site-row[data-selected='true'] .count {
        color: var(--dwc-text-muted);
      }

      .reports {
        margin: 0 0 var(--dwc-space-1) var(--dwc-space-5);
        padding-left: var(--dwc-space-3);
        border-left: 1px solid var(--dwc-border);
      }

      .report-button {
        display: flex;
        align-items: center;
        gap: var(--dwc-space-2);
        /* Shares the row with its actions now, so it takes the remaining space
           rather than the whole width. */
        flex: 1;
        min-width: 0;
        min-height: 2rem;
        padding: var(--dwc-space-1) var(--dwc-space-2);
        border: none;
        border-radius: var(--dwc-radius-sm);
        background: none;
        color: var(--dwc-text-muted);
        font: inherit;
        font-size: var(--dwc-text-xs);
        text-align: left;
        cursor: pointer;
      }
      .report-button:hover {
        background: var(--dwc-surface-hover);
        color: var(--dwc-text);
      }
      .report-button[aria-current='true'] {
        background: var(--dwc-brand-subtle);
        color: var(--dwc-brand-text);
        font-weight: var(--dwc-weight-medium);
      }

      .when {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .score {
        font-variant-numeric: tabular-nums;
      }

      .actions {
        display: flex;
        gap: 0;
        opacity: 0;
        transition: opacity var(--dwc-duration-fast) var(--dwc-ease);
      }
      /* Revealed on hover for pointer users, but always reachable by keyboard —
         opacity rather than display so focus is never trapped on a hidden node. */
      .site-row:hover .actions,
      .site-row:focus-within .actions,
      .report-row:hover .actions,
      .report-row:focus-within .actions {
        opacity: 1;
      }

      .report-row {
        display: flex;
        align-items: center;
        gap: var(--dwc-space-1);
        border-radius: var(--dwc-radius);
      }
      .report-row:hover {
        background: var(--dwc-surface-hover);
      }

      .action {
        display: grid;
        place-items: center;
        width: 1.75rem;
        height: 1.75rem;
        border: none;
        border-radius: var(--dwc-radius-sm);
        background: none;
        color: var(--dwc-text-subtle);
        cursor: pointer;
        --dwc-icon-size: 0.875rem;
      }
      .action:hover {
        background: var(--dwc-surface-active);
        color: var(--dwc-text);
      }

      .empty {
        padding: var(--dwc-space-4) var(--dwc-space-3);
        font-size: var(--dwc-text-sm);
        color: var(--dwc-text-subtle);
        text-align: center;
      }

      /*
       * Rail mode: the health dot survives, everything else goes.
       *
       * Hidden with 'display: none' rather than by clipping, deliberately. A
       * label that is merely invisible is still a tab stop and still read aloud,
       * which makes the rail worse for a keyboard user than the full sidebar
       * rather than merely narrower.
       */
      :host([collapsed]) .name,
      :host([collapsed]) .count,
      :host([collapsed]) .actions,
      :host([collapsed]) .disclosure,
      :host([collapsed]) .reports,
      :host([collapsed]) .empty {
        display: none;
      }
      :host([collapsed]) .favicon {
        width: 1.5rem;
        height: 1.5rem;
      }
      :host([collapsed]) .site-button {
        justify-content: center;
        padding: var(--dwc-space-1);
        /* A bare dot is a poor target. The row keeps a full-height hit area, and
           the title attribute is what identifies the site on hover — its visible
           name is gone, so the accessible name has to be explicit. */
        min-height: var(--dwc-tap-target);
      }
      :host([collapsed]) .site-row {
        justify-content: center;
      }
    `,
  ];

  @property({ type: Array })
  accessor sites: SiteWithSummary[] = [];

  @property({ type: Object })
  accessor reportsBySite: Record<string, ReportSummary[]> = {};

  @property({ type: String, attribute: 'selected-site' })
  accessor selectedSite: string | null = null;

  @property({ type: String, attribute: 'selected-report' })
  accessor selectedReport: string | null = null;

  /** Rail mode: reflected so the host-level style rules above can match on it. */
  @property({ type: Boolean, reflect: true })
  accessor collapsed = false;

  /**
   * Which list is being shown. Changing it collapses everything.
   *
   * Expansion state used to survive the switch between active and archived, so a
   * site left open showed an empty history: the app clears its cache on the
   * toggle, and nothing re-requested it because the disclosure never fired again.
   * Collapsing is both the fix and the honest reading — it is a different list.
   */
  @property({ type: String })
  accessor view: 'active' | 'archived' = 'active';

  @state()
  private accessor expanded = new Set<string>();

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('view') && changed.get('view') !== undefined) this.expanded = new Set();
  }

  /**
   * Reveal whichever site is current.
   *
   * The selection highlight is on the site row, but the report that is actually
   * open is a child of it — so a collapsed site marked "selected" showed the
   * reader a highlight with nothing under it to explain what they were looking at.
   *
   * Only on change, never on every render: re-expanding on each update would fight
   * a reader who deliberately collapsed the site they are reading. `site-expand`
   * is emitted alongside, because the host loads a site's history lazily and would
   * otherwise open an empty branch.
   */
  protected override updated(changed: Map<string, unknown>): void {
    if (!changed.has('selectedSite')) return;

    const site = this.selectedSite;
    if (site === null || site === '' || this.expanded.has(site)) return;

    this.expanded = new Set(this.expanded).add(site);
    this.emit('site-expand', { siteId: site });
  }

  private toggle(siteId: string): void {
    const next = new Set(this.expanded);
    if (next.has(siteId)) next.delete(siteId);
    else {
      next.add(siteId);
      this.emit('site-expand', { siteId });
    }
    this.expanded = next;
  }

  private emit(name: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  override render(): TemplateResult {
    if (this.sites.length === 0) {
      return html`<p class="empty">No sites yet. Run your first check above.</p>`;
    }

    return html`
      <ul role="tree" aria-label="Saved sites and their reports">
        ${this.sites.map((site) => this.renderSite(site))}
      </ul>
    `;
  }

  private renderSite(site: SiteWithSummary): TemplateResult {
    const isExpanded = this.expanded.has(site.id);
    const culprit = site.latestReport?.culprit ?? null;
    const dot = culprit === null ? 'var(--dwc-unknown)' : `var(--dwc-${CULPRIT_TONE[culprit]})`;
    const reports = this.reportsBySite[site.id] ?? [];

    return html`
      <li role="treeitem" aria-expanded=${isExpanded ? 'true' : 'false'}>
        <div class="site-row" data-selected=${this.selectedSite === site.id ? 'true' : 'false'}>
          <button
            class="disclosure"
            type="button"
            aria-expanded=${isExpanded ? 'true' : 'false'}
            aria-label=${isExpanded ? `Collapse ${site.label}` : `Expand ${site.label}`}
            @click=${() => this.toggle(site.id)}
          >
            <dwc-icon name="chevron"></dwc-icon>
          </button>

          <button
            class="site-button"
            type="button"
            title=${site.label}
            aria-label=${site.label}
            @click=${() => this.emit('site-select', { siteId: site.id })}
          >
            ${this.renderFavicon(site, dot)}
            <span class="name">${site.label}</span>
            <span class="count">${site.reportCount}</span>
          </button>

          <span class="actions">
            <button
              class="action"
              type="button"
              title="Run a new check for ${site.label}"
              aria-label="Run a new check for ${site.label}"
              @click=${() => this.emit('site-rerun', { siteId: site.id, url: site.url })}
            >
              <dwc-icon name="refresh"></dwc-icon>
            </button>
            <button
              class="action"
              type="button"
              title="Rename ${site.label}"
              aria-label="Rename ${site.label}"
              @click=${() => this.emit('site-rename', { siteId: site.id, label: site.label })}
            >
              <dwc-icon name="pencil"></dwc-icon>
            </button>
            <button
              class="action"
              type="button"
              title=${site.archivedAt === null ? `Archive ${site.label}` : `Restore ${site.label}`}
              aria-label=${
                site.archivedAt === null ? `Archive ${site.label}` : `Restore ${site.label}`
              }
              @click=${() =>
                this.emit(site.archivedAt === null ? 'site-archive' : 'site-restore', {
                  siteId: site.id,
                })}
            >
              <dwc-icon name=${site.archivedAt === null ? 'archive' : 'restore'}></dwc-icon>
            </button>
            <button
              class="action"
              type="button"
              title="Delete ${site.label}"
              aria-label="Delete ${site.label}"
              @click=${() => this.emit('site-delete', { siteId: site.id, label: site.label })}
            >
              <dwc-icon name="trash"></dwc-icon>
            </button>
          </span>
        </div>

        ${
          isExpanded
            ? html`
                <ul class="reports" role="group">
                  ${
                    reports.length === 0
                      ? html`<li class="empty" style="padding: var(--dwc-space-2)">
                          No reports yet
                        </li>`
                      : reports.map((report) => this.renderReport(report))
                  }
                </ul>
              `
            : nothing
        }
      </li>
    `;
  }

  /**
   * The site's favicon, or a monogram when it has none.
   *
   * Decorative in both cases: the button already carries the site's name, so
   * announcing the icon too would just repeat it. When the sidebar is collapsed
   * this is the only thing left of the row, which is why it grows there — a bare
   * status dot was a four-pixel target with nothing to identify it.
   */
  private renderFavicon(site: SiteWithSummary, dot: string): TemplateResult {
    return html`
      <span class="favicon" aria-hidden="true">
        <span class="favicon-art">
          ${
            site.iconDataUrl === null
              ? html`<span class="monogram" style="--hue: ${hueFor(site.url)}">
                  ${initialFor(site.label)}
                </span>`
              : html`<img src=${site.iconDataUrl} alt="" loading="lazy" decoding="async" />`
          }
        </span>
        <span class="status-dot" style="--dot: ${dot}"></span>
      </span>
    `;
  }

  private renderReport(report: ReportSummary): TemplateResult {
    const tone = report.culprit === null ? 'unknown' : CULPRIT_TONE[report.culprit];

    /*
     * Every action names the run it belongs to, not just the verb.
     *
     * A history list produces five buttons in a row; labelling them all "Delete"
     * leaves anyone using a screen reader or voice control with five identical
     * targets and no way to say which one they mean.
     */
    const when = formatWhen(report.createdAt);
    const archived = report.archivedAt !== null;

    return html`
      <li role="treeitem">
        <div class="report-row">
          <button
            class="report-button"
            type="button"
            aria-current=${this.selectedReport === report.id ? 'true' : 'false'}
            @click=${() =>
              this.emit('report-select', { reportId: report.id, siteId: report.siteId })}
          >
            <span class="status-dot" style="--dot: var(--dwc-${tone})" aria-hidden="true"></span>
            <span class="when">${when}</span>
            ${report.score === null ? nothing : html`<span class="score">${report.score}</span>`}
          </button>

          <span class="actions">
            <button
              class="action"
              type="button"
              title=${archived ? `Restore the check from ${when}` : `Archive the check from ${when}`}
              aria-label=${
                archived ? `Restore the check from ${when}` : `Archive the check from ${when}`
              }
              @click=${() =>
                this.emit(archived ? 'report-restore' : 'report-archive', {
                  reportId: report.id,
                  siteId: report.siteId,
                })}
            >
              <dwc-icon name=${archived ? 'restore' : 'archive'}></dwc-icon>
            </button>
            <button
              class="action"
              type="button"
              title="Delete the check from ${when}"
              aria-label="Delete the check from ${when}"
              @click=${() =>
                this.emit('report-delete', {
                  reportId: report.id,
                  siteId: report.siteId,
                  label: `the check from ${when}`,
                })}
            >
              <dwc-icon name="trash"></dwc-icon>
            </button>
          </span>
        </div>
      </li>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dwc-nav-tree': DwcNavTree;
  }
}
