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

      .reports {
        margin: 0 0 var(--dwc-space-1) var(--dwc-space-5);
        padding-left: var(--dwc-space-3);
        border-left: 1px solid var(--dwc-border);
      }

      .report-button {
        display: flex;
        align-items: center;
        gap: var(--dwc-space-2);
        width: 100%;
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
      .site-row:focus-within .actions {
        opacity: 1;
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

  @state()
  private accessor expanded = new Set<string>();

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
            @click=${() => this.emit('site-select', { siteId: site.id })}
          >
            <span class="status-dot" style="--dot: ${dot}" aria-hidden="true"></span>
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

  private renderReport(report: ReportSummary): TemplateResult {
    const tone = report.culprit === null ? 'unknown' : CULPRIT_TONE[report.culprit];

    return html`
      <li role="treeitem">
        <button
          class="report-button"
          type="button"
          aria-current=${this.selectedReport === report.id ? 'true' : 'false'}
          @click=${() => this.emit('report-select', { reportId: report.id, siteId: report.siteId })}
        >
          <span class="status-dot" style="--dot: var(--dwc-${tone})" aria-hidden="true"></span>
          <span class="when">${formatWhen(report.createdAt)}</span>
          ${report.score === null ? nothing : html`<span class="score">${report.score}</span>`}
        </button>
      </li>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dwc-nav-tree': DwcNavTree;
  }
}
