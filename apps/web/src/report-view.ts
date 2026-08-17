import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import type { Evidence, Report, Verdict } from '@dwc/contracts';
import { sharedStyles, type WaterfallPhase } from '@dwc/ui';
import '@dwc/ui';

/**
 * The report itself — all three layers of progressive disclosure.
 *
 * Layer 1 (the verdict banner and vantage tiles) is always visible and free of
 * jargon. Layer 2 is the ranked findings. Layer 3 lives inside each finding card
 * behind a disclosure. Nothing technical appears before it has been explained.
 */
export class DwcReportView extends LitElement {
  static override styles = [
    ...sharedStyles,
    css`
      :host {
        display: block;
        /* Container queries throughout, so the report lays out correctly whether
           it has the full window or sits beside an open sidebar. */
        container-type: inline-size;
      }

      .stack {
        display: grid;
        gap: var(--dwc-space-6);
      }

      .headline-row {
        display: grid;
        gap: var(--dwc-space-4);
        align-items: start;
      }

      @container (min-width: 48rem) {
        .headline-row {
          grid-template-columns: 1fr auto;
        }
      }

      .tiles {
        display: grid;
        gap: var(--dwc-space-3);
      }

      @container (min-width: 34rem) {
        .tiles {
          grid-template-columns: repeat(3, 1fr);
        }
      }

      section {
        display: grid;
        gap: var(--dwc-space-3);
      }

      h3 {
        margin: 0;
        font-size: var(--dwc-text-lg);
        font-weight: var(--dwc-weight-semibold);
        color: var(--dwc-text);
      }

      .section-note {
        margin: 0;
        font-size: var(--dwc-text-sm);
        color: var(--dwc-text-muted);
        max-width: 70ch;
      }

      .findings {
        display: grid;
        gap: var(--dwc-space-3);
      }

      .panel {
        padding: var(--dwc-space-5);
        border: 1px solid var(--dwc-border);
        border-radius: var(--dwc-radius-lg);
        background: var(--dwc-surface-raised);
      }

      dl.glossary {
        display: grid;
        gap: var(--dwc-space-3);
        margin: 0;
      }
      dl.glossary > div {
        display: grid;
        gap: var(--dwc-space-1);
      }
      dt {
        font-size: var(--dwc-text-sm);
        font-weight: var(--dwc-weight-semibold);
        color: var(--dwc-text);
      }
      dd {
        margin: 0;
        font-size: var(--dwc-text-sm);
        line-height: var(--dwc-leading-normal);
        color: var(--dwc-text-muted);
      }

      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: var(--dwc-space-4);
        font-size: var(--dwc-text-xs);
        color: var(--dwc-text-subtle);
      }

      .all-clear {
        display: flex;
        align-items: center;
        gap: var(--dwc-space-3);
        padding: var(--dwc-space-4);
        border-radius: var(--dwc-radius);
        border: 1px solid var(--dwc-ok-border);
        background: var(--dwc-ok-subtle);
        color: var(--dwc-ok-text);
        font-size: var(--dwc-text-sm);
      }

      /* Print stylesheet: the report is meant to be forwarded to a hosting
         provider or client, so it must survive Ctrl+P without a PDF library. */
      @media print {
        .no-print {
          display: none !important;
        }
        .panel,
        .tiles > * {
          break-inside: avoid;
        }
      }
    `,
  ];

  /** Static properties API rather than decorators — see tsconfig.json. */
  static override properties = {
    report: { type: Object },
    liveVerdict: { type: Object },
  };

  report!: Report;

  /** Revised verdict after browser evidence arrives; falls back to the stored one. */
  liveVerdict: Verdict | null = null;

  private get verdict(): Verdict | null {
    return this.liveVerdict ?? this.report.verdict;
  }

  override render(): TemplateResult {
    const verdict = this.verdict;
    if (verdict === null) {
      return html`<p class="section-note">This check did not complete.</p>`;
    }

    const evidence = this.report.evidence;

    return html`
      <div class="stack">
        <div class="headline-row">
          <dwc-verdict-banner
            .culprit=${verdict.culprit}
            .headline=${verdict.headline}
            .plain=${verdict.plain}
            .confidence=${verdict.confidence}
            confidence-reason=${verdict.confidenceReason ?? ''}
          ></dwc-verdict-banner>

          <dwc-score-dial .score=${verdict.score} caption="Health"></dwc-score-dial>
        </div>

        <div class="tiles">
          <dwc-vantage-tile
            icon="server"
            .status=${verdict.vantages.server.status}
            .label=${verdict.vantages.server.label}
            .summary=${verdict.vantages.server.summary}
            .score=${verdict.vantages.server.score}
          ></dwc-vantage-tile>
          <dwc-vantage-tile
            icon="wifi"
            .status=${verdict.vantages.userConnection.status}
            .label=${verdict.vantages.userConnection.label}
            .summary=${verdict.vantages.userConnection.summary}
            .score=${verdict.vantages.userConnection.score}
          ></dwc-vantage-tile>
          <dwc-vantage-tile
            icon="route"
            .status=${verdict.vantages.networkPath.status}
            .label=${verdict.vantages.networkPath.label}
            .summary=${verdict.vantages.networkPath.summary}
            .score=${verdict.vantages.networkPath.score}
          ></dwc-vantage-tile>
        </div>

        ${evidence === null ? nothing : this.renderWaterfall(evidence)}

        <section>
          <h3>What we found</h3>
          ${verdict.findings.length === 0
            ? html`
                <p class="all-clear">
                  <dwc-icon name="check"></dwc-icon>
                  We found nothing that needs fixing.
                </p>
              `
            : html`
                <p class="section-note">
                  Listed worst first. Each one says who can actually fix it — open any of them for the
                  technical detail and specific steps.
                </p>
                <div class="findings">
                  ${verdict.findings.map(
                    (finding) => html`<dwc-finding-card .finding=${finding}></dwc-finding-card>`,
                  )}
                </div>
              `}
        </section>

        ${verdict.glossary.length === 0
          ? nothing
          : html`
              <section>
                <h3>Jargon, explained</h3>
                <div class="panel">
                  <dl class="glossary">
                    ${verdict.glossary.map(
                      (entry) => html`
                        <div>
                          <dt>${entry.term}</dt>
                          <dd>${entry.definition}</dd>
                        </div>
                      `,
                    )}
                  </dl>
                </div>
              </section>
            `}

        <div class="meta">
          <span>Checked ${new Date(this.report.createdAt).toLocaleString()}</span>
          ${evidence === null ? nothing : html`<span>${evidence.server.target.normalizedUrl}</span>`}
          <span>Engine ${verdict.engineVersion}</span>
        </div>
      </div>
    `;
  }

  /**
   * The phase breakdown.
   *
   * Descriptions are written so the chart explains itself — a reader should not
   * need to already know what "TTFB" means to understand which step was slow.
   */
  private renderWaterfall(evidence: Evidence): TemplateResult {
    const server = evidence.server;
    const reachable = server.addresses.find((a) => a.reachable);

    const phases: WaterfallPhase[] = [
      {
        label: 'Finding the address',
        durationMs: server.dns.lookupMs.value,
        description: 'Turning the website name into a number computers can route to.',
        tone: 'info',
      },
      {
        label: 'Opening the connection',
        durationMs: reachable?.tcpConnectMs.value ?? null,
        description: 'Reaching the server. Mostly determined by physical distance.',
        tone: 'brand',
      },
      {
        label: 'Securing the connection',
        durationMs: server.tls?.handshakeMs.value ?? null,
        description: 'Setting up encryption so the connection is private.',
        tone: 'ok',
      },
      {
        label: 'Waiting for the server',
        durationMs: server.http?.ttfbMs.value ?? null,
        description: 'The server thinking before it sends anything. This is its own doing, not the network.',
        tone: 'warn',
      },
      {
        label: 'Downloading the page',
        durationMs: server.http?.downloadMs.value ?? null,
        description: 'Transferring the page content once it started arriving.',
        tone: 'unknown',
      },
    ];

    return html`
      <section>
        <h3>Where the time went</h3>
        <p class="section-note">
          Measured from our own server on a fast connection, so these numbers describe the site itself
          rather than your connection to it.
        </p>
        <div class="panel">
          <dwc-waterfall .phases=${phases}></dwc-waterfall>
        </div>
      </section>
    `;
  }
}

customElements.define('dwc-report-view', DwcReportView);

declare global {
  interface HTMLElementTagNameMap {
    'dwc-report-view': DwcReportView;
  }
}
