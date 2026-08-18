import type { VantageStatus } from '@dwc/contracts';
import { LitElement, css, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { sharedStyles } from '../styles/shared.js';
import './dwc-icon.js';

/**
 * One corner of the diagnostic triangle: their server, your connection, or the
 * path between.
 *
 * Showing all three side by side — including the ones that are *fine* — is the
 * point. "Your connection tested healthy" is genuinely useful information and
 * stops people troubleshooting the wrong thing.
 */
const STATUS_LABEL: Record<VantageStatus, string> = {
  ok: 'Healthy',
  degraded: 'Slower than it should be',
  bad: 'Problem found',
  unknown: 'Not measured',
};

const STATUS_TONE: Record<VantageStatus, string> = {
  ok: 'ok',
  degraded: 'warn',
  bad: 'bad',
  unknown: 'unknown',
};

const STATUS_ICON: Record<VantageStatus, string> = {
  ok: 'check',
  degraded: 'warning',
  bad: 'error',
  unknown: 'question',
};

@customElement('dwc-vantage-tile')
export class DwcVantageTile extends LitElement {
  static override styles = [
    ...sharedStyles,
    css`
      :host {
        display: block;
      }

      .tile {
        display: grid;
        gap: var(--dwc-space-3);
        height: 100%;
        padding: var(--dwc-space-4);
        border-radius: var(--dwc-radius-lg);
        border: 1px solid var(--dwc-border);
        background: var(--dwc-surface-raised);
        box-shadow: var(--dwc-shadow-sm);
      }

      .head {
        display: flex;
        align-items: center;
        gap: var(--dwc-space-2);
      }

      .glyph {
        display: grid;
        place-items: center;
        width: 1.75rem;
        height: 1.75rem;
        flex: none;
        border-radius: var(--dwc-radius);
        background: var(--tone-subtle);
        color: var(--tone-text);
        --dwc-icon-size: 1rem;
      }

      .label {
        font-size: var(--dwc-text-sm);
        font-weight: var(--dwc-weight-semibold);
        color: var(--dwc-text);
      }

      .status {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--dwc-space-2);
      }

      .state {
        font-size: var(--dwc-text-xs);
        font-weight: var(--dwc-weight-medium);
        color: var(--tone-text);
      }

      .score {
        font-size: var(--dwc-text-lg);
        font-weight: var(--dwc-weight-bold);
        font-variant-numeric: tabular-nums;
        color: var(--dwc-text);
      }

      .summary {
        margin: 0;
        font-size: var(--dwc-text-sm);
        line-height: var(--dwc-leading-normal);
        color: var(--dwc-text-muted);
      }

      /* A quiet strength meter. Hidden from assistive tech because the score and
         state text above already say the same thing more precisely. */
      .bar {
        height: 0.25rem;
        border-radius: var(--dwc-radius-full);
        background: var(--dwc-surface-sunken);
        overflow: hidden;
      }
      .bar > i {
        display: block;
        height: 100%;
        border-radius: inherit;
        background: var(--tone-base);
        transition: width var(--dwc-duration-slow) var(--dwc-ease);
      }
    `,
  ];

  @property({ type: String })
  accessor status: VantageStatus = 'unknown';

  @property({ type: String })
  accessor label = '';

  @property({ type: String })
  accessor summary = '';

  @property({ type: Number })
  accessor score: number | null = null;

  @property({ type: String })
  accessor icon = 'server';

  override render(): TemplateResult {
    const tone = STATUS_TONE[this.status];

    return html`
      <div
        class="tile"
        style="--tone-base: var(--dwc-${tone}); --tone-subtle: var(--dwc-${tone}-subtle); --tone-text: var(--dwc-${tone}-text);"
      >
        <div class="head">
          <span class="glyph"><dwc-icon name=${this.icon}></dwc-icon></span>
          <span class="label">${this.label}</span>
        </div>

        <div class="status">
          <span class="state">
            <dwc-icon name=${STATUS_ICON[this.status]}></dwc-icon>
            ${STATUS_LABEL[this.status]}
          </span>
          ${this.score === null ? null : html`<span class="score">${this.score}</span>`}
        </div>

        ${
          this.score === null
            ? null
            : html`<div class="bar" aria-hidden="true"><i style="width: ${this.score}%"></i></div>`
        }

        <p class="summary">${this.summary}</p>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dwc-vantage-tile': DwcVantageTile;
  }
}
