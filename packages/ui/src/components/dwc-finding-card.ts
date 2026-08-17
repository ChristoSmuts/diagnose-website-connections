import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { Finding, Owner, Severity } from '@dwc/contracts';
import { sharedStyles } from '../styles/shared.js';
import './dwc-icon.js';
import './dwc-badge.js';
import './dwc-button.js';

const SEVERITY_TONE: Record<Severity, string> = {
  critical: 'bad',
  major: 'bad',
  minor: 'warn',
  info: 'info',
};

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  major: 'Important',
  minor: 'Minor',
  info: 'Worth knowing',
};

/**
 * Who can act on this — the question people actually have.
 *
 * Phrased from the reader's point of view rather than as a category name:
 * "You can fix this" is instantly actionable in a way that "user" is not.
 */
const OWNER_LABEL: Record<Owner, string> = {
  'site-owner': 'The website owner fixes this',
  you: 'You can fix this',
  'your-isp': 'Your internet provider',
  nobody: 'Nobody — this is just how it is',
};

const OWNER_TONE: Record<Owner, string> = {
  'site-owner': 'info',
  you: 'brand',
  'your-isp': 'warn',
  nobody: 'unknown',
};

/**
 * A single finding, written for three audiences at once.
 *
 * Layer 2 (title, plain, impact) is always visible and contains no unexplained
 * jargon. Layer 3 (evidence, technical detail, remediation) is behind a
 * disclosure, so an engineer can reach it in one click and everyone else is
 * never confronted with it.
 */
@customElement('dwc-finding-card')
export class DwcFindingCard extends LitElement {
  static override styles = [
    ...sharedStyles,
    css`
      :host {
        display: block;
      }

      article {
        border: 1px solid var(--dwc-border);
        border-left: 3px solid var(--tone-base);
        border-radius: var(--dwc-radius);
        background: var(--dwc-surface-raised);
        overflow: hidden;
      }

      .body {
        display: grid;
        gap: var(--dwc-space-3);
        padding: var(--dwc-space-4);
      }

      .tags {
        display: flex;
        flex-wrap: wrap;
        gap: var(--dwc-space-2);
      }

      h3 {
        margin: 0;
        font-size: var(--dwc-text-lg);
        font-weight: var(--dwc-weight-semibold);
        line-height: var(--dwc-leading-tight);
        color: var(--dwc-text);
        text-wrap: balance;
      }

      p {
        margin: 0;
        font-size: var(--dwc-text-sm);
        line-height: var(--dwc-leading-relaxed);
        color: var(--dwc-text-muted);
        max-width: 70ch;
      }

      .impact {
        padding-left: var(--dwc-space-3);
        border-left: 2px solid var(--dwc-border);
        color: var(--dwc-text-subtle);
      }

      .toggle {
        display: flex;
        align-items: center;
        gap: var(--dwc-space-2);
        width: 100%;
        min-height: var(--dwc-tap-target);
        padding: var(--dwc-space-2) var(--dwc-space-4);
        border: none;
        border-top: 1px solid var(--dwc-border);
        background: var(--dwc-surface-sunken);
        color: var(--dwc-text-muted);
        font: inherit;
        font-size: var(--dwc-text-sm);
        font-weight: var(--dwc-weight-medium);
        cursor: pointer;
        text-align: left;
      }
      .toggle:hover {
        background: var(--dwc-surface-hover);
        color: var(--dwc-text);
      }
      .toggle dwc-icon {
        transition: transform var(--dwc-duration) var(--dwc-ease);
      }
      .toggle[aria-expanded='true'] dwc-icon {
        transform: rotate(90deg);
      }

      .details {
        display: grid;
        gap: var(--dwc-space-4);
        padding: var(--dwc-space-4);
        border-top: 1px solid var(--dwc-border);
        background: var(--dwc-surface-sunken);
      }

      h4 {
        margin: 0 0 var(--dwc-space-2);
        font-size: var(--dwc-text-xs);
        font-weight: var(--dwc-weight-semibold);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--dwc-text-subtle);
      }

      dl {
        display: grid;
        gap: var(--dwc-space-1);
        margin: 0;
        font-size: var(--dwc-text-sm);
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: var(--dwc-space-2);
        padding: var(--dwc-space-1) 0;
        border-bottom: 1px dashed var(--dwc-border);
      }
      dt {
        color: var(--dwc-text-muted);
      }
      dd {
        margin: 0;
        font-weight: var(--dwc-weight-medium);
        font-variant-numeric: tabular-nums;
        color: var(--dwc-text);
      }

      /* Marks a number the browser could not actually observe. Trust depends on
         this being visible rather than quietly presented as fact. */
      .provenance {
        font-size: var(--dwc-text-xs);
        font-weight: var(--dwc-weight-normal);
        color: var(--dwc-text-subtle);
        font-style: italic;
      }

      .technical {
        font-family: var(--dwc-font-mono);
        font-size: var(--dwc-text-xs);
        line-height: var(--dwc-leading-normal);
        color: var(--dwc-text-muted);
        white-space: pre-wrap;
        word-break: break-word;
      }

      ol {
        margin: 0;
        padding-left: var(--dwc-space-5);
        display: grid;
        gap: var(--dwc-space-2);
        font-size: var(--dwc-text-sm);
        line-height: var(--dwc-leading-normal);
        color: var(--dwc-text-muted);
      }

      pre {
        margin: 0;
        padding: var(--dwc-space-3);
        border-radius: var(--dwc-radius);
        border: 1px solid var(--dwc-border);
        background: var(--dwc-surface);
        /* Long config lines must scroll inside the block, never widen the page. */
        overflow-x: auto;
        font-family: var(--dwc-font-mono);
        font-size: var(--dwc-text-xs);
        line-height: 1.6;
        color: var(--dwc-text);
      }

      .snippet-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--dwc-space-2);
        margin-bottom: var(--dwc-space-2);
      }

      .improvement {
        display: flex;
        align-items: flex-start;
        gap: var(--dwc-space-2);
        font-size: var(--dwc-text-sm);
        color: var(--dwc-ok-text);
      }
    `,
  ];

  @property({ type: Object })
  accessor finding!: Finding;

  @state()
  private accessor expanded = false;

  @state()
  private accessor copied = false;

  private toggle(): void {
    this.expanded = !this.expanded;
  }

  private async copySnippet(): Promise<void> {
    const code = this.finding.remediation?.snippet?.code;
    if (code === undefined) return;
    try {
      await navigator.clipboard.writeText(code);
      this.copied = true;
      setTimeout(() => {
        this.copied = false;
      }, 2000);
    } catch {
      // Clipboard access can be denied; the code is still selectable by hand.
    }
  }

  override render(): TemplateResult {
    const f = this.finding;
    const tone = SEVERITY_TONE[f.severity];
    const detailsId = `details-${f.code}`;

    return html`
      <article style="--tone-base: var(--dwc-${tone});">
        <div class="body">
          <div class="tags">
            <dwc-badge tone=${tone} dot>${SEVERITY_LABEL[f.severity]}</dwc-badge>
            <dwc-badge tone=${OWNER_TONE[f.owner]}>${OWNER_LABEL[f.owner]}</dwc-badge>
            ${f.confidence === 'high'
              ? nothing
              : html`<dwc-badge tone="unknown"
                  >${f.confidence === 'medium' ? 'Fairly confident' : 'Low confidence'}</dwc-badge
                >`}
          </div>

          <h3>${f.title}</h3>
          <p>${f.plain}</p>
          <p class="impact">${f.impact}</p>
        </div>

        <button
          class="toggle"
          type="button"
          aria-expanded=${this.expanded ? 'true' : 'false'}
          aria-controls=${detailsId}
          @click=${this.toggle}
        >
          <dwc-icon name="chevron"></dwc-icon>
          ${this.expanded ? 'Hide the technical detail' : 'Show the technical detail and how to fix it'}
        </button>

        ${this.expanded ? this.renderDetails(detailsId) : nothing}
      </article>
    `;
  }

  private renderDetails(id: string): TemplateResult {
    const f = this.finding;

    return html`
      <div class="details" id=${id}>
        ${f.evidence.length === 0
          ? nothing
          : html`
              <section>
                <h4>What we measured</h4>
                <dl>
                  ${f.evidence.map(
                    (row) => html`
                      <div class="row">
                        <dt>${row.label}</dt>
                        <dd>
                          ${row.value}
                          ${row.provenance === 'measured'
                            ? nothing
                            : html`<span class="provenance">
                                (${row.provenance === 'inferred' ? 'worked out' : 'not available'})
                              </span>`}
                        </dd>
                      </div>
                    `,
                  )}
                </dl>
              </section>
            `}

        <section>
          <h4>In technical terms</h4>
          <div class="technical">${f.technical}</div>
        </section>

        ${f.remediation === null
          ? nothing
          : html`
              <section>
                <h4>How to fix it</h4>
                <p style="margin-bottom: var(--dwc-space-3)">${f.remediation.summary}</p>
                <ol>
                  ${f.remediation.steps.map((step) => html`<li>${step}</li>`)}
                </ol>

                ${f.remediation.snippet === null
                  ? nothing
                  : html`
                      <div style="margin-top: var(--dwc-space-3)">
                        <div class="snippet-head">
                          <h4 style="margin: 0">
                            ${f.remediation.snippet.caption ?? f.remediation.snippet.language}
                          </h4>
                          <dwc-button size="sm" variant="ghost" @click=${() => void this.copySnippet()}>
                            <dwc-icon name=${this.copied ? 'check' : 'copy'}></dwc-icon>
                            ${this.copied ? 'Copied' : 'Copy'}
                          </dwc-button>
                        </div>
                        <pre><code>${f.remediation.snippet.code}</code></pre>
                      </div>
                    `}
                ${f.remediation.expectedImprovement === null
                  ? nothing
                  : html`
                      <p class="improvement" style="margin-top: var(--dwc-space-3)">
                        <dwc-icon name="check"></dwc-icon>
                        ${f.remediation.expectedImprovement}
                      </p>
                    `}
              </section>
            `}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dwc-finding-card': DwcFindingCard;
  }
}
