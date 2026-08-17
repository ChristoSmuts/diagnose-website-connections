import { LitElement, css, html, svg, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { sharedStyles } from '../styles/shared.js';

/**
 * Circular 0–100 health score.
 *
 * The number is rendered as real text in the centre, not as part of the SVG
 * artwork, so it can be selected, zoomed and read by assistive technology. The
 * ring itself is `aria-hidden` and the whole component exposes a `meter` role
 * with the value — a screen reader hears "72 out of 100", not "circle".
 */
@customElement('dwc-score-dial')
export class DwcScoreDial extends LitElement {
  static override styles = [
    ...sharedStyles,
    css`
      :host {
        display: inline-flex;
        --size: 7.5rem;
      }
      :host([size='sm']) {
        --size: 4rem;
      }
      :host([size='lg']) {
        --size: 10rem;
      }

      .dial {
        position: relative;
        width: var(--size);
        height: var(--size);
        display: grid;
        place-items: center;
      }

      svg {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        /* Start the arc at 12 o'clock rather than 3. */
        transform: rotate(-90deg);
      }

      .track {
        stroke: var(--dwc-border);
      }

      .value {
        stroke: var(--tone);
        stroke-linecap: round;
        transition: stroke-dashoffset var(--dwc-duration-slow) var(--dwc-ease);
      }

      .readout {
        position: relative;
        text-align: center;
        line-height: 1;
      }

      .number {
        font-size: calc(var(--size) * 0.28);
        font-weight: var(--dwc-weight-bold);
        color: var(--dwc-text);
        font-variant-numeric: tabular-nums;
      }

      .caption {
        margin-top: 0.25em;
        font-size: calc(var(--size) * 0.1);
        color: var(--dwc-text-subtle);
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
    `,
  ];

  @property({ type: Number })
  accessor score = 0;

  @property({ type: String, reflect: true })
  accessor size: 'sm' | 'md' | 'lg' = 'md';

  @property({ type: String })
  accessor caption = 'Score';

  /** Thresholds match the engine's own bands so the colour never contradicts the verdict. */
  private get toneVar(): string {
    if (this.score >= 80) return 'var(--dwc-ok)';
    if (this.score >= 50) return 'var(--dwc-warn)';
    return 'var(--dwc-bad)';
  }

  override render(): TemplateResult {
    const radius = 42;
    const circumference = 2 * Math.PI * radius;
    const clamped = Math.max(0, Math.min(100, this.score));
    const offset = circumference * (1 - clamped / 100);

    return html`
      <div
        class="dial"
        style="--tone: ${this.toneVar}"
        role="meter"
        aria-valuenow=${clamped}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-label="${this.caption}: ${String(clamped)} out of 100"
      >
        ${svg`
          <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
            <circle class="track" cx="50" cy="50" r=${radius} fill="none" stroke-width="8" />
            <circle
              class="value"
              cx="50" cy="50" r=${radius}
              fill="none" stroke-width="8"
              stroke-dasharray=${circumference}
              stroke-dashoffset=${offset}
            />
          </svg>
        `}
        <div class="readout" aria-hidden="true">
          <div class="number">${clamped}</div>
          <div class="caption">${this.caption}</div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dwc-score-dial': DwcScoreDial;
  }
}
