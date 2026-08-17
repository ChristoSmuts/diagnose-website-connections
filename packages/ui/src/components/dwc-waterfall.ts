import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { sharedStyles } from '../styles/shared.js';

export interface WaterfallPhase {
  label: string;
  durationMs: number | null;
  /** Plain-language explanation, shown beneath the bar. */
  description: string;
  tone: 'ok' | 'warn' | 'bad' | 'unknown' | 'info' | 'brand';
}

/**
 * Where the time actually went, phase by phase.
 *
 * Built from CSS-sized bars rather than SVG so it reflows naturally on a phone
 * and inherits font metrics. Crucially it also renders a real `<table>` for
 * assistive technology: a bar chart conveys nothing to a screen reader, and the
 * numbers here are the whole point of the section.
 */
@customElement('dwc-waterfall')
export class DwcWaterfall extends LitElement {
  static override styles = [
    ...sharedStyles,
    css`
      :host {
        display: block;
      }

      ol {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: var(--dwc-space-3);
      }

      .phase {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: var(--dwc-space-1) var(--dwc-space-3);
        align-items: baseline;
      }

      .name {
        font-size: var(--dwc-text-sm);
        font-weight: var(--dwc-weight-medium);
        color: var(--dwc-text);
      }

      .time {
        font-size: var(--dwc-text-sm);
        font-weight: var(--dwc-weight-semibold);
        font-variant-numeric: tabular-nums;
        color: var(--dwc-text);
      }

      .time.absent {
        font-weight: var(--dwc-weight-normal);
        color: var(--dwc-text-subtle);
        font-style: italic;
      }

      .track {
        grid-column: 1 / -1;
        height: 0.5rem;
        border-radius: var(--dwc-radius-full);
        background: var(--dwc-surface-sunken);
        overflow: hidden;
      }

      .fill {
        height: 100%;
        border-radius: inherit;
        background: var(--tone);
        /* Hairline so a sub-millisecond phase is still visible. */
        min-width: 2px;
        transition: width var(--dwc-duration-slow) var(--dwc-ease);
      }

      .description {
        grid-column: 1 / -1;
        margin: 0;
        font-size: var(--dwc-text-xs);
        line-height: var(--dwc-leading-normal);
        color: var(--dwc-text-muted);
      }

      .total {
        display: flex;
        justify-content: space-between;
        gap: var(--dwc-space-3);
        margin-top: var(--dwc-space-4);
        padding-top: var(--dwc-space-3);
        border-top: 1px solid var(--dwc-border);
        font-size: var(--dwc-text-sm);
        font-weight: var(--dwc-weight-semibold);
        color: var(--dwc-text);
      }
    `,
  ];

  @property({ type: Array })
  accessor phases: WaterfallPhase[] = [];

  @property({ type: String })
  accessor caption = 'Where the time went';

  override render(): TemplateResult {
    const measured = this.phases.filter((p) => p.durationMs !== null);
    const total = measured.reduce((sum, p) => sum + (p.durationMs ?? 0), 0);
    // Scale against the largest single phase so small ones stay legible; scaling
    // against the total would flatten everything but the slowest step.
    const largest = Math.max(...measured.map((p) => p.durationMs ?? 0), 1);

    return html`
      <ol aria-hidden="true">
        ${this.phases.map((phase) => this.renderPhase(phase, largest))}
      </ol>

      <div class="total" aria-hidden="true">
        <span>Total</span>
        <span>${Math.round(total)}ms</span>
      </div>

      ${this.renderAccessibleTable(total)}
    `;
  }

  private renderPhase(phase: WaterfallPhase, largest: number): TemplateResult {
    const width = phase.durationMs === null ? 0 : (phase.durationMs / largest) * 100;

    return html`
      <li class="phase" style="--tone: var(--dwc-${phase.tone})">
        <span class="name">${phase.label}</span>
        <span class="time ${phase.durationMs === null ? 'absent' : ''}">
          ${phase.durationMs === null ? 'not measured' : `${String(Math.round(phase.durationMs))}ms`}
        </span>
        ${phase.durationMs === null
          ? nothing
          : html`<div class="track"><div class="fill" style="width: ${width}%"></div></div>`}
        <p class="description">${phase.description}</p>
      </li>
    `;
  }

  /**
   * The same data as a table, for screen readers.
   *
   * Not an afterthought: without this the entire section is invisible to anyone
   * not looking at it, and this chart carries the core evidence of the report.
   */
  private renderAccessibleTable(total: number): TemplateResult {
    return html`
      <table class="sr-only">
        <caption>
          ${this.caption}
        </caption>
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col">Time taken</th>
            <th scope="col">What it means</th>
          </tr>
        </thead>
        <tbody>
          ${this.phases.map(
            (phase) => html`
              <tr>
                <th scope="row">${phase.label}</th>
                <td>
                  ${phase.durationMs === null
                    ? 'not measured'
                    : `${String(Math.round(phase.durationMs))} milliseconds`}
                </td>
                <td>${phase.description}</td>
              </tr>
            `,
          )}
          <tr>
            <th scope="row">Total</th>
            <td>${Math.round(total)} milliseconds</td>
            <td>Combined time for every measured step.</td>
          </tr>
        </tbody>
      </table>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dwc-waterfall': DwcWaterfall;
  }
}
