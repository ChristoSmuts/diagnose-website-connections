import type { Check, CheckStatus } from '@dwc/contracts';
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { sharedStyles } from '../styles/shared.js';
import './dwc-badge.js';
import './dwc-icon.js';

/**
 * One check, collapsed to a line and expandable to its full technical detail.
 *
 * This is the rung of the report that findings could not provide. A finding only
 * exists when something is wrong, so a healthy site used to offer nothing to
 * inspect at all. A check is an observation rather than an accusation: it has no
 * severity and no owner, and when it warrants action it points at the finding that
 * makes the case.
 *
 * Expanded content is deliberately *not* simplified. Layer 1 is written for
 * someone who wants an answer; this is written for someone who wants the truth,
 * with real header names, cipher suites and exact values.
 */
const STATUS: Record<
  CheckStatus,
  { tone: 'ok' | 'warn' | 'bad' | 'unknown'; icon: string; label: string }
> = {
  pass: { tone: 'ok', icon: 'pass', label: 'Pass' },
  warn: { tone: 'warn', icon: 'warning', label: 'Worth improving' },
  fail: { tone: 'bad', icon: 'error', label: 'Problem' },
  // "We did not run this" and "we ran it and could not tell" are different facts,
  // so they get different words and different icons — never one grey state.
  skipped: { tone: 'unknown', icon: 'blocked', label: 'Not run' },
  unavailable: { tone: 'unknown', icon: 'question', label: 'Could not tell' },
};

const PROVENANCE_LABEL: Record<string, string> = {
  measured: 'Measured directly',
  inferred: 'Derived from other measurements',
  unavailable: 'Could not be obtained',
};

@customElement('dwc-check-row')
export class DwcCheckRow extends LitElement {
  static override styles = [
    ...sharedStyles,
    css`
      /*
       * min-width: 0 is what actually lets a row narrow.
       *
       * Rows are grid items, and a grid item's automatic minimum size is its
       * min-content width — so the track cannot go below the widest row however
       * hard the row's own children try to truncate. Ellipsis rules inside are
       * necessary and, on their own, completely ineffective: a long headline
       * still forced the whole page wider than a 320 px viewport.
       */
      :host {
        display: block;
        min-width: 0;
      }

      .row {
        position: relative;
        border: 1px solid var(--dwc-border);
        border-radius: var(--dwc-radius);
        background: var(--dwc-surface-raised);
        overflow: hidden;
      }
      .row[data-open='true'] {
        border-color: var(--dwc-border-strong);
        box-shadow: var(--dwc-shadow-sm);
      }

      .rail {
        width: 2px;
      }

      /* The whole line is the control: a small chevron-only hit area is a
         needlessly precise target, especially on a phone. */
      .summary {
        display: flex;
        align-items: center;
        gap: var(--dwc-space-3);
        width: 100%;
        min-height: var(--dwc-tap-target);
        padding: var(--dwc-space-3) var(--dwc-space-3) var(--dwc-space-3) var(--dwc-space-4);
        border: none;
        background: none;
        text-align: left;
        font: inherit;
        color: inherit;
        cursor: pointer;
      }
      .summary:hover {
        background: var(--dwc-surface-hover);
      }

      .status {
        flex: none;
        display: grid;
        place-items: center;
        color: var(--tone-base);
        --dwc-icon-size: 1.125rem;
      }

      .titles {
        flex: 1 1 auto;
        min-width: 0;
        display: grid;
        gap: 0.1rem;
      }
      .title {
        font-size: var(--dwc-text-sm);
        font-weight: var(--dwc-weight-semibold);
        color: var(--dwc-text);
      }
      .sub {
        font-size: var(--dwc-text-xs);
        color: var(--dwc-text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /*
       * Shrinks and truncates rather than holding its intrinsic width.
       *
       * This was 'flex: none', which held for as long as every headline was a
       * word or two — "AS13335", "Cloudflare", "TLS 1.3". A longer one then
       * pushed the chevron clean off the right of a 320 px viewport and took the
       * whole page's horizontal scroll with it. Truncating loses the tail of a
       * value that is repeated in full in the detail below; overflowing loses
       * the control that opens it.
       */
      .headline {
        flex: 0 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: var(--dwc-text-sm);
        color: var(--dwc-text-muted);
      }

      .chevron {
        flex: none;
        color: var(--dwc-text-subtle);
        --dwc-icon-size: 1rem;
      }
      @media (prefers-reduced-motion: no-preference) {
        .chevron {
          transition: transform var(--dwc-duration-fast) var(--dwc-ease);
        }
      }
      .row[data-open='true'] .chevron {
        transform: rotate(90deg);
      }

      .detail {
        padding: 0 var(--dwc-space-4) var(--dwc-space-4) var(--dwc-space-4);
        display: grid;
        gap: var(--dwc-space-4);
        border-top: 1px solid var(--dwc-border);
        padding-top: var(--dwc-space-4);
      }

      .technical {
        margin: 0;
        font-size: var(--dwc-text-sm);
        line-height: var(--dwc-leading-relaxed);
        color: var(--dwc-text-muted);
        max-width: 74ch;
        /* The engine writes multi-paragraph explanations for some checks. */
        white-space: pre-line;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--dwc-text-xs);
      }
      caption {
        text-align: left;
        margin-bottom: var(--dwc-space-2);
      }
      th,
      td {
        padding: var(--dwc-space-2) var(--dwc-space-3);
        text-align: left;
        vertical-align: top;
        border-bottom: 1px solid var(--dwc-border);
      }
      tbody tr:last-child th,
      tbody tr:last-child td {
        border-bottom: none;
      }
      tbody tr:nth-child(even) {
        background: var(--dwc-surface-sunken);
      }
      th {
        font-weight: var(--dwc-weight-medium);
        color: var(--dwc-text-muted);
        white-space: nowrap;
      }
      td {
        color: var(--dwc-text);
        overflow-wrap: anywhere;
      }

      /* Values are rendered monospaced and tabular; prose is not. */
      td.value {
        font-family: var(--dwc-font-mono);
        font-variant-numeric: tabular-nums;
      }

      /*
       * Provenance is shown as a marker with a real title, not colour alone.
       * A number the engine could not obtain must never be able to render as
       * though it had been observed.
       */
      .prov {
        display: inline-block;
        margin-left: var(--dwc-space-2);
        font-size: 0.9em;
        color: var(--dwc-text-subtle);
        cursor: help;
      }

      .links {
        font-size: var(--dwc-text-xs);
        color: var(--dwc-text-muted);
      }

      /* Print shows everything: a collapsed section is useless on paper. */
      @media print {
        .detail {
          display: grid !important;
        }
        .chevron {
          display: none;
        }
      }
    `,
  ];

  @property({ type: Object })
  accessor check: Check | null = null;

  @property({ type: Boolean, reflect: true })
  accessor open = false;

  private toggle(): void {
    this.open = !this.open;
    this.dispatchEvent(
      new CustomEvent('toggle-check', {
        detail: { id: this.check?.id ?? null, open: this.open },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private renderEvidence(check: Check): TemplateResult | typeof nothing {
    if (check.evidence.length === 0) return nothing;

    return html`
      <table>
        <caption class="eyebrow">
          Evidence
        </caption>
        <tbody>
          ${check.evidence.map(
            (row) => html`
              <tr>
                <th scope="row">${row.label}</th>
                <td class="value">
                  ${row.value}${
                    row.provenance === 'measured'
                      ? nothing
                      : html`<abbr
                          class="prov"
                          title=${PROVENANCE_LABEL[row.provenance] ?? row.provenance}
                          >${row.provenance === 'inferred' ? '(derived)' : '(unavailable)'}</abbr
                        >`
                  }
                </td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    `;
  }

  override render(): TemplateResult {
    const check = this.check;
    if (check === null) return html`${nothing}`;

    const status = STATUS[check.status];
    const detailId = `detail-${check.id.replace(/\W/g, '-')}`;

    return html`
      <div
        class="row"
        data-open=${this.open ? 'true' : 'false'}
        style="--tone-base: var(--dwc-${status.tone});"
      >
        <span class="rail" aria-hidden="true"></span>

        <button
          class="summary"
          type="button"
          aria-expanded=${this.open ? 'true' : 'false'}
          aria-controls=${detailId}
          @click=${this.toggle}
        >
          <span class="status">
            <dwc-icon
              name=${status.icon}
              weight=${check.status === 'pass' || check.status === 'fail' ? 'fill' : 'regular'}
              label=${status.label}
            ></dwc-icon>
          </span>

          <span class="titles">
            <span class="title">${check.title}</span>
            <span class="sub">${check.summary}</span>
          </span>

          ${
            check.headline === null
              ? nothing
              : html`<span class="headline num">${check.headline}</span>`
          }

          <dwc-icon class="chevron" name="chevron"></dwc-icon>
        </button>

        <div class="detail" id=${detailId} ?hidden=${!this.open}>
          <p class="technical">${check.technical}</p>
          ${this.renderEvidence(check)}
          ${
            check.relatedFindings.length === 0
              ? nothing
              : html`<p class="links">
                  Related ${check.relatedFindings.length === 1 ? 'finding' : 'findings'}:
                  ${check.relatedFindings.join(', ')}
                </p>`
          }
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dwc-check-row': DwcCheckRow;
  }
}
