import type { Check, CheckPhase, Evidence, Report, Verdict } from '@dwc/contracts';
import { CHECK_PHASE_ORDER } from '@dwc/contracts';
import { sharedStyles, type WaterfallPhase } from '@dwc/ui';
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import '@dwc/ui';

/**
 * Phase headings, in the reader's terms rather than the protocol's.
 *
 * The engine groups checks by protocol stage; these are the words a reader can
 * follow without already knowing the stack.
 */
const PHASE_LABELS: Record<CheckPhase, string> = {
  dns: 'Finding the address',
  connectivity: 'Reaching the server',
  tls: 'Securing the connection',
  http: 'Requesting the page',
  stability: 'Consistency over several attempts',
  network: 'Where the site is hosted',
  client: 'Your own connection',
  path: 'The route between you and the site',
};

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

      .tiles {
        display: grid;
        gap: var(--dwc-space-3);
      }

      @container (min-width: 34rem) {
        .tiles {
          /* Set inline from the number of measured vantages. A fixed repeat(3)
             left empty tracks behind whenever one could not be measured. */
          grid-template-columns: repeat(var(--tiles, 3), 1fr);
        }
      }

      /* The unmeasured vantages, demoted but never dropped. Quieter than a tile
         and louder than nothing, which is the whole point. */
      .not-measured {
        display: flex;
        gap: var(--dwc-space-3);
        align-items: start;
        margin-top: calc(var(--dwc-space-6) * -1 + var(--dwc-space-3));
        padding: var(--dwc-space-3) var(--dwc-space-4);
        border: 1px solid var(--dwc-border);
        border-radius: var(--dwc-radius-lg);
        background: var(--dwc-surface-sunken);
        color: var(--dwc-text-muted);
        font-size: var(--dwc-text-sm);
        line-height: var(--dwc-leading-normal);
      }

      .not-measured dwc-icon {
        --dwc-icon-size: 1.1em;
        flex: none;
        margin-top: 0.15em;
        color: var(--dwc-text-subtle);
      }

      .not-measured-head {
        margin: 0 0 var(--dwc-space-1);
        font-weight: var(--dwc-weight-semibold);
        color: var(--dwc-text);
      }

      .not-measured-item {
        margin: 0;
      }

      .not-measured-item + .not-measured-item {
        margin-top: var(--dwc-space-2);
      }

      .not-measured-item strong {
        font-weight: var(--dwc-weight-medium);
        color: var(--dwc-text);
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

      .section-head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: var(--dwc-space-3);
      }

      .check-group {
        display: grid;
        gap: var(--dwc-space-2);
        margin-top: var(--dwc-space-2);
      }

      .checks {
        display: grid;
        gap: var(--dwc-space-2);
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
        .not-measured,
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
    previousScore: { type: Number },
    openChecks: { state: true },
    problemsOnly: { state: true },
  };

  report!: Report;

  /** Revised verdict after browser evidence arrives; falls back to the stored one. */
  liveVerdict: Verdict | null = null;

  /** The prior report's score for this site, so the dial can show movement. */
  previousScore: number | null = null;

  private openChecks = new Set<string>();

  /**
   * Collapsed by default, and filtered to problems first.
   *
   * A healthy site produces around thirty passing checks. Showing them all
   * expanded would bury Layer 1, which is the part most readers should stop at.
   */
  private problemsOnly = false;

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
        <!-- The dial is slotted into the banner so the two read as one object,
             and so the banner controls how they reflow together. -->
        <dwc-verdict-banner
          .culprit=${verdict.culprit}
          .headline=${verdict.headline}
          .plain=${verdict.plain}
          .confidence=${verdict.confidence}
          .score=${verdict.score}
          confidence-reason=${verdict.confidenceReason ?? ''}
        >
          <dwc-score-dial
            slot="score"
            .score=${verdict.score}
            .previous=${this.previousScore}
            caption="Health"
          ></dwc-score-dial>
        </dwc-verdict-banner>

        ${this.renderVantages(verdict)}
        ${evidence === null ? nothing : this.renderWaterfall(evidence)}

        <section>
          <h3>What we found</h3>
          ${
            verdict.findings.length === 0
              ? html`
                  <p class="all-clear">
                    <dwc-icon name="check"></dwc-icon>
                    We found nothing that needs fixing.
                  </p>
                `
              : html`
                  <p class="section-note">
                    Listed worst first. Each one says who can actually fix it — open any of them for
                    the technical detail and specific steps.
                  </p>
                  <div class="findings">
                    ${verdict.findings.map(
                      (finding) => html`<dwc-finding-card .finding=${finding}></dwc-finding-card>`,
                    )}
                  </div>
                `
          }
        </section>

        ${verdict.checks.length === 0 ? nothing : this.renderChecks(verdict.checks)}
        ${
          verdict.glossary.length === 0
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
              `
        }

        <div class="meta">
          <span>Checked ${new Date(this.report.createdAt).toLocaleString()}</span>
          ${evidence === null ? nothing : html`<span>${evidence.server.target.normalizedUrl}</span>`}
          <span>Engine ${verdict.engineVersion}</span>
        </div>
      </div>
    `;
  }

  /**
   * Every check performed, passes included — Layer 3 proper.
   *
   * This exists because findings only describe problems, which left a healthy site
   * with nothing to inspect. Grouped by phase in the order a request actually
   * happens, so reading down the list follows the request itself.
   */
  private renderChecks(checks: readonly Check[]): TemplateResult {
    const counts = {
      pass: checks.filter((c) => c.status === 'pass').length,
      problems: checks.filter((c) => c.status === 'warn' || c.status === 'fail').length,
      // "Not run" and "could not tell" are grouped for the summary line only;
      // each row still states which of the two it was.
      inconclusive: checks.filter((c) => c.status === 'skipped' || c.status === 'unavailable')
        .length,
    };

    const visible = this.problemsOnly
      ? checks.filter((c) => c.status === 'warn' || c.status === 'fail')
      : checks;

    const groups = CHECK_PHASE_ORDER.map((phase) => ({
      phase,
      label: PHASE_LABELS[phase],
      items: visible.filter((c) => c.phase === phase),
    })).filter((g) => g.items.length > 0);

    return html`
      <section>
        <div class="section-head">
          <h3>Every check we ran</h3>
          <dwc-button
            variant="ghost"
            size="sm"
            class="no-print"
            @click=${this.toggleProblemsOnly}
            aria-pressed=${this.problemsOnly ? 'true' : 'false'}
          >
            <dwc-icon name="filter"></dwc-icon>
            ${this.problemsOnly ? 'Show all checks' : 'Only show problems'}
          </dwc-button>
        </div>

        <p class="section-note">
          ${String(counts.pass)} passed, ${String(counts.problems)} worth attention,
          ${String(counts.inconclusive)} inconclusive. Open any of them for the full technical
          detail and the evidence behind it.
        </p>

        ${
          visible.length === 0
            ? html`<p class="section-note">No problems were found in any check.</p>`
            : groups.map(
                (group) => html`
                  <div class="check-group">
                    <p class="eyebrow">${group.label}</p>
                    <div class="checks">
                      ${group.items.map(
                        (check) => html`
                          <dwc-check-row
                            .check=${check}
                            .open=${this.openChecks.has(check.id)}
                            @toggle-check=${this.onToggleCheck}
                          ></dwc-check-row>
                        `,
                      )}
                    </div>
                  </div>
                `,
              )
        }
      </section>
    `;
  }

  private toggleProblemsOnly(): void {
    this.problemsOnly = !this.problemsOnly;
    this.requestUpdate();
  }

  /**
   * Open state is held here rather than left inside each row.
   *
   * The filter re-renders the list, and Lit reuses DOM across that render; keeping
   * the set in the parent means a check the reader opened stays open instead of
   * silently collapsing when the filter is toggled.
   */
  private onToggleCheck(event: Event): void {
    const detail = (event as CustomEvent<{ id: string | null; open: boolean }>).detail;
    if (detail.id === null) return;

    const next = new Set(this.openChecks);
    if (detail.open) next.add(detail.id);
    else next.delete(detail.id);

    this.openChecks = next;
    this.requestUpdate();
  }

  /**
   * The three corners of the triangle — but only the ones that were measured.
   *
   * A vantage with `status: 'unknown'` has no score, no bar and nothing to compare;
   * it is a card-shaped explanation of an absence. Given equal weight beside a
   * vantage that was actually measured, two of them made a local install look like
   * a report that had mostly failed, when in fact it had done everything it could.
   *
   * What must not happen is the absence going unmentioned — a reader who is shown
   * one tile and no note has been told the test was complete. So the unmeasured
   * ones move to a line underneath carrying the engine's own explanation, verbatim.
   * Note this hides nothing that is *fine*: a healthy "your connection" still gets
   * its tile, because "your connection tested healthy" is a genuinely useful thing
   * to be told and stops people troubleshooting the wrong end.
   */
  private renderVantages(verdict: Verdict): TemplateResult {
    const all = [
      { icon: 'server', vantage: verdict.vantages.server },
      { icon: 'wifi', vantage: verdict.vantages.userConnection },
      { icon: 'route', vantage: verdict.vantages.networkPath },
    ];

    const measured = all.filter((v) => v.vantage.status !== 'unknown');
    // Nothing measured at all: there is no hierarchy left to express, and reducing
    // Layer 1 to a banner and a footnote would read as a broken page rather than an
    // honest one. Keep the cards.
    const tiles = measured.length === 0 ? all : measured;
    const omitted = measured.length === 0 ? [] : all.filter((v) => v.vantage.status === 'unknown');

    return html`
      <div class="tiles" style="--tiles: ${String(tiles.length)}">
        ${tiles.map(
          ({ icon, vantage }) => html`
            <dwc-vantage-tile
              icon=${icon}
              .status=${vantage.status}
              .label=${vantage.label}
              .summary=${vantage.summary}
              .score=${vantage.score}
            ></dwc-vantage-tile>
          `,
        )}
      </div>

      ${
        omitted.length === 0
          ? nothing
          : html`
              <div class="not-measured" data-testid="not-measured">
                <dwc-icon name="info"></dwc-icon>
                <div>
                  <p class="not-measured-head">
                    ${omitted.length === 1 ? 'One thing we could not measure' : 'What we could not measure'}
                  </p>
                  <!-- The engine's wording, unchanged. It carries both the reason and
                       the remedy, it is covered by copy.test.ts, and paraphrasing it
                       here is how the prose ends up contradicting the report. -->
                  ${omitted.map(
                    ({ vantage }) => html`
                      <p class="not-measured-item">
                        <strong>${vantage.label}.</strong> ${vantage.summary}
                      </p>
                    `,
                  )}
                </div>
              </div>
            `
      }
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
        description:
          'The server thinking before it sends anything. This is its own doing, not the network.',
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
          Measured from our own server on a fast connection, so these numbers describe the site
          itself rather than your connection to it.
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
