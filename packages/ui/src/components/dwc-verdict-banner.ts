import { LitElement, css, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { Culprit } from '@dwc/contracts';
import { sharedStyles } from '../styles/shared.js';
import './dwc-icon.js';
import './dwc-badge.js';

/**
 * Layer 1 of the report: the answer, in one sentence.
 *
 * This is the only part of the report most people will read, so it gets the most
 * space and the plainest language. The culprit determines the tone, the icon and
 * the wording of the "who owns this" line — never colour alone.
 */
const PRESENTATION: Record<
  Culprit,
  { tone: 'ok' | 'warn' | 'bad' | 'unknown' | 'info'; icon: string; owner: string }
> = {
  healthy: { tone: 'ok', icon: 'check', owner: 'Nothing needs fixing' },
  server: { tone: 'bad', icon: 'server', owner: 'The website owner needs to fix this' },
  'user-connection': { tone: 'warn', icon: 'wifi', owner: 'This one is on your side' },
  'network-path': { tone: 'warn', icon: 'route', owner: 'Your internet provider’s routing' },
  mixed: { tone: 'bad', icon: 'warning', owner: 'Two separate problems' },
  unreachable: { tone: 'bad', icon: 'error', owner: 'The site could not be reached' },
  inconclusive: { tone: 'unknown', icon: 'question', owner: 'Not enough information' },
};

@customElement('dwc-verdict-banner')
export class DwcVerdictBanner extends LitElement {
  static override styles = [
    ...sharedStyles,
    css`
      :host {
        display: block;
      }

      .banner {
        display: grid;
        gap: var(--dwc-space-4);
        padding: var(--dwc-space-5);
        border-radius: var(--dwc-radius-lg);
        border: 1px solid var(--tone-border);
        background: var(--tone-subtle);
      }

      @container (min-width: 40rem) {
        .banner {
          padding: var(--dwc-space-8);
        }
      }

      .top {
        display: flex;
        align-items: flex-start;
        gap: var(--dwc-space-3);
      }

      .mark {
        display: grid;
        place-items: center;
        width: 2.5rem;
        height: 2.5rem;
        flex: none;
        border-radius: var(--dwc-radius-full);
        background: var(--tone-base);
        color: var(--dwc-surface-raised);
        --dwc-icon-size: 1.5rem;
      }

      h2 {
        margin: 0;
        font-size: var(--dwc-text-2xl);
        font-weight: var(--dwc-weight-bold);
        line-height: var(--dwc-leading-tight);
        color: var(--dwc-text);
        /* Long headlines are the norm here; keep them from becoming a wall. */
        max-width: 34ch;
        text-wrap: balance;
      }

      p {
        margin: 0;
        font-size: var(--dwc-text-base);
        line-height: var(--dwc-leading-relaxed);
        color: var(--dwc-text-muted);
        max-width: 68ch;
      }

      .meta {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--dwc-space-2);
      }

      .confidence {
        display: inline-flex;
        align-items: center;
        gap: var(--dwc-space-1);
        font-size: var(--dwc-text-xs);
        color: var(--dwc-text-subtle);
      }
    `,
  ];

  @property({ type: String })
  accessor culprit: Culprit = 'inconclusive';

  @property({ type: String })
  accessor headline = '';

  @property({ type: String })
  accessor plain = '';

  @property({ type: String })
  accessor confidence: 'high' | 'medium' | 'low' = 'high';

  @property({ type: String, attribute: 'confidence-reason' })
  accessor confidenceReason: string | null = null;

  override render(): TemplateResult {
    const style = PRESENTATION[this.culprit];
    const tone = style.tone;

    return html`
      <div
        class="banner"
        style="--tone-base: var(--dwc-${tone}); --tone-subtle: var(--dwc-${tone}-subtle); --tone-border: var(--dwc-${tone}-border);"
      >
        <div class="top">
          <span class="mark"><dwc-icon name=${style.icon}></dwc-icon></span>
          <h2>${this.headline}</h2>
        </div>

        <p>${this.plain}</p>

        <div class="meta">
          <dwc-badge tone=${tone} size="lg" dot>${style.owner}</dwc-badge>

          ${
            // Confidence is shown whenever it is not high, with the reason. A
            // hedged conclusion presented confidently is how trust is lost.
            this.confidence === 'high'
              ? null
              : html`
                  <span class="confidence">
                    <dwc-icon name="info"></dwc-icon>
                    ${this.confidence === 'medium' ? 'Fairly confident' : 'Low confidence'}${this
                      .confidenceReason
                      ? html` — ${this.confidenceReason}`
                      : null}
                  </span>
                `
          }
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dwc-verdict-banner': DwcVerdictBanner;
  }
}
