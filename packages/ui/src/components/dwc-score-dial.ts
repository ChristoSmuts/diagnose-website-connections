import { LitElement, css, html, svg, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedStyles } from '../styles/shared.js';

/**
 * Circular 0–100 health score.
 *
 * The number is rendered as real text in the centre, not as part of the SVG
 * artwork, so it can be selected, zoomed and read by assistive technology. The
 * ring itself is `aria-hidden` and the whole component exposes a `meter` role
 * with the value — a screen reader hears "72 out of 100", not "circle".
 *
 * The arc sweeps and the number counts up on change. Both are suppressed under
 * `prefers-reduced-motion`, where the final value is rendered immediately: the
 * displayed figure must be correct at every instant, not merely at the end of an
 * animation, because someone may screenshot or read it mid-flight.
 */
@customElement('dwc-score-dial')
export class DwcScoreDial extends LitElement {
  static override styles = [
    ...sharedStyles,
    css`
      :host {
        display: inline-flex;
        --size: 8rem;
      }
      :host([size='sm']) {
        --size: 4.5rem;
      }
      :host([size='lg']) {
        --size: 11rem;
      }

      .dial {
        position: relative;
        width: var(--size);
        height: var(--size);
        display: grid;
        place-items: center;
        isolation: isolate;
      }

      svg {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        /* Start the arc at 12 o'clock rather than 3. */
        transform: rotate(-90deg);
        overflow: visible;
      }

      .track {
        stroke: var(--dwc-border);
        opacity: 0.7;
      }

      .value {
        stroke: url(#dwc-dial-gradient);
        stroke-linecap: round;
        filter: drop-shadow(0 0 6px color-mix(in oklab, var(--tone) 45%, transparent));
      }

      @media (prefers-reduced-motion: no-preference) {
        .value {
          transition: stroke-dashoffset var(--dwc-duration-slower) var(--dwc-ease-out);
        }
      }

      .readout {
        position: relative;
        text-align: center;
        line-height: 1;
      }

      .number {
        font-family: var(--dwc-font-display);
        font-size: calc(var(--size) * 0.3);
        font-weight: var(--dwc-weight-bold);
        letter-spacing: var(--dwc-tracking-tight);
        color: var(--dwc-text);
        /* Tabular figures stop the centre jittering while counting up. */
        font-variant-numeric: tabular-nums;
      }

      .caption {
        margin-top: 0.35em;
        font-size: calc(var(--size) * 0.095);
        font-weight: var(--dwc-weight-semibold);
        color: var(--dwc-text-subtle);
        text-transform: uppercase;
        letter-spacing: var(--dwc-tracking-wide);
      }

      .delta {
        margin-top: 0.3em;
        font-size: calc(var(--size) * 0.1);
        font-variant-numeric: tabular-nums;
        color: var(--dwc-text-subtle);
      }
      .delta[data-direction='up'] {
        color: var(--dwc-ok-text);
      }
      .delta[data-direction='down'] {
        color: var(--dwc-bad-text);
      }

      @media print {
        .value {
          filter: none;
        }
      }
    `,
  ];

  @property({ type: Number })
  accessor score = 0;

  @property({ type: String, reflect: true })
  accessor size: 'sm' | 'md' | 'lg' = 'md';

  @property({ type: String })
  accessor caption = 'Score';

  /**
   * The previous report's score, when there is one. Shows movement rather than
   * just position — the question after a re-run is "did it get better?".
   */
  @property({ type: Number })
  accessor previous: number | null = null;

  /** What the readout currently shows; walks toward `score` while animating. */
  @state()
  private accessor displayed = 0;

  private frame = 0;

  override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('score')) this.animateTo(this.clamped);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    cancelAnimationFrame(this.frame);
  }

  private get clamped(): number {
    return Math.max(0, Math.min(100, Math.round(this.score)));
  }

  /**
   * Counts the readout up to the target.
   *
   * Driven by elapsed time rather than a fixed step per frame, so the duration is
   * the same on a 120Hz display as on a 60Hz one.
   */
  private animateTo(target: number): void {
    cancelAnimationFrame(this.frame);

    const reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduced) {
      this.displayed = target;
      return;
    }

    const from = this.displayed;
    if (from === target) return;

    const durationMs = 620;
    const start = performance.now();

    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / durationMs);
      // Ease-out cubic, matching --dwc-ease-out closely enough for a number.
      const eased = 1 - Math.pow(1 - t, 3);
      this.displayed = Math.round(from + (target - from) * eased);
      if (t < 1) this.frame = requestAnimationFrame(step);
    };

    this.frame = requestAnimationFrame(step);
  }

  /** Thresholds match the engine's own bands so the colour never contradicts the verdict. */
  private get toneVar(): string {
    if (this.clamped >= 80) return 'var(--dwc-ok)';
    if (this.clamped >= 50) return 'var(--dwc-warn)';
    return 'var(--dwc-bad)';
  }

  private renderDelta(): TemplateResult | null {
    if (this.previous === null) return null;

    const change = this.clamped - Math.round(this.previous);
    if (change === 0) {
      return html`<div class="delta" data-direction="flat">No change</div>`;
    }

    const direction = change > 0 ? 'up' : 'down';
    const sign = change > 0 ? '+' : '−';
    return html`<div class="delta" data-direction=${direction}>
      ${sign}${String(Math.abs(change))} since last check
    </div>`;
  }

  override render(): TemplateResult {
    const radius = 42;
    const circumference = 2 * Math.PI * radius;
    const value = this.clamped;
    const offset = circumference * (1 - this.displayed / 100);

    const label =
      this.previous === null
        ? `${this.caption}: ${String(value)} out of 100`
        : `${this.caption}: ${String(value)} out of 100, previously ${String(Math.round(this.previous))}`;

    return html`
      <div
        class="dial"
        style="--tone: ${this.toneVar}"
        role="meter"
        aria-valuenow=${value}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-label=${label}
      >
        ${svg`
          <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
            <defs>
              <!--
                A gradient along the arc gives the ring depth without introducing a
                second colour meaning: both stops are the same tone, one lightened,
                so the hue still maps to the score band exactly as before.
              -->
              <linearGradient id="dwc-dial-gradient" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="color-mix(in oklab, var(--tone) 78%, white)" />
                <stop offset="100%" stop-color="var(--tone)" />
              </linearGradient>
            </defs>
            <circle class="track" cx="50" cy="50" r=${radius} fill="none" stroke-width="9" />
            <circle
              class="value"
              cx="50" cy="50" r=${radius}
              fill="none" stroke-width="9"
              stroke-dasharray=${circumference}
              stroke-dashoffset=${offset}
            />
          </svg>
        `}
        <div class="readout" aria-hidden="true">
          <div class="number">${this.displayed}</div>
          <div class="caption">${this.caption}</div>
          ${this.renderDelta()}
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
