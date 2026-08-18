import type { Culprit } from '@dwc/contracts';
import { LitElement, css, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { sharedStyles } from '../styles/shared.js';
import './dwc-badge.js';
import './dwc-icon.js';

/**
 * Layer 1 of the report: the answer, in one sentence.
 *
 * This is the only part of the report most people will read, so it gets the most
 * space, the plainest language and the strongest visual treatment. The culprit
 * determines the tone, the icon and the wording of the "who owns this" line —
 * never colour alone, which is why every state carries an icon and a word too.
 *
 * Visually this is the one place the design is allowed to be expressive: an
 * ambient wash keyed to the verdict, display type, and a duotone icon whose rear
 * layer picks up the tone. Everything below it in the report stays quiet.
 */
const PRESENTATION: Record<
  Culprit,
  { tone: 'ok' | 'warn' | 'bad' | 'unknown' | 'info'; icon: string; owner: string }
> = {
  healthy: { tone: 'ok', icon: 'verified', owner: 'Nothing needs fixing' },
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
        container-type: inline-size;
      }

      .banner {
        display: grid;
        gap: var(--dwc-space-5);
        padding: var(--dwc-space-6) var(--dwc-space-5);
        border-radius: var(--dwc-radius-xl);
        border: 1px solid var(--tone-border);
        box-shadow:
          inset 0 1px 0 var(--dwc-highlight),
          var(--dwc-shadow-md);
      }

      /*
       * Two columns once there is room: the dial reads as part of the verdict
       * rather than a separate widget parked beneath it. A container query rather
       * than a viewport media query, because this component also renders inside
       * the narrower report column and inside the print layout.
       */
      @container (min-width: 34rem) {
        .banner {
          padding: var(--dwc-space-8);
          grid-template-columns: 1fr auto;
          grid-template-areas:
            'head dial'
            'body dial'
            'meta dial';
          align-items: start;
          column-gap: var(--dwc-space-8);
        }
        .head {
          grid-area: head;
        }
        .prose {
          grid-area: body;
        }
        .meta {
          grid-area: meta;
        }
        .dial {
          grid-area: dial;
          align-self: center;
        }
      }

      .head {
        display: flex;
        align-items: flex-start;
        gap: var(--dwc-space-4);
      }

      /*
       * The mark carries the tone as a duotone icon rather than a solid disc.
       * --dwc-icon-back points the rear layer at the tone, so the glyph is tinted
       * by the verdict instead of being a grey silhouette.
       */
      .mark {
        display: grid;
        place-items: center;
        width: 3rem;
        height: 3rem;
        flex: none;
        border-radius: var(--dwc-radius-lg);
        background: color-mix(in oklab, var(--tone-base) 12%, var(--dwc-surface-raised));
        border: 1px solid var(--tone-border);
        color: var(--tone-base);
        --dwc-icon-size: 1.75rem;
        --dwc-icon-back: var(--tone-base);
        --dwc-icon-back-opacity: 0.28;
      }

      h2 {
        margin: 0;
        font-family: var(--dwc-font-display);
        font-size: var(--dwc-text-3xl);
        font-weight: var(--dwc-weight-bold);
        line-height: var(--dwc-leading-tight);
        letter-spacing: var(--dwc-tracking-tight);
        color: var(--dwc-text);
        /* Long headlines are the norm here; keep them from becoming a wall. */
        max-width: 30ch;
        text-wrap: balance;
      }

      p {
        margin: 0;
        font-size: var(--dwc-text-base);
        line-height: var(--dwc-leading-relaxed);
        color: var(--dwc-text-muted);
        max-width: 62ch;
      }

      .meta {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--dwc-space-3);
      }

      .confidence {
        display: inline-flex;
        align-items: flex-start;
        gap: var(--dwc-space-2);
        font-size: var(--dwc-text-xs);
        line-height: var(--dwc-leading-normal);
        color: var(--dwc-text-subtle);
        max-width: 46ch;
      }
      .confidence dwc-icon {
        flex: none;
        --dwc-icon-size: 1rem;
      }

      .dial {
        display: grid;
        place-items: center;
      }

      /* Gradients and shadows carry no information; drop them for print. */
      @media print {
        .banner {
          box-shadow: none;
        }
        .banner::before {
          display: none;
        }
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
        class="banner wash"
        style="--tone-base: var(--dwc-${tone}); --tone-subtle: var(--dwc-${tone}-subtle); --tone-border: var(--dwc-${tone}-border);"
      >
        <div class="head">
          <span class="mark">
            <dwc-icon name=${style.icon} weight="duotone"></dwc-icon>
          </span>
          <h2>${this.headline}</h2>
        </div>

        <p class="prose">${this.plain}</p>

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
                    <span>
                      ${this.confidence === 'medium' ? 'Fairly confident' : 'Low confidence'}${
                        this.confidenceReason ? html` — ${this.confidenceReason}` : null
                      }
                    </span>
                  </span>
                `
          }
        </div>

        <!-- Slotted so the report owns the score value and this component owns
             only the layout relationship between the verdict and the dial. -->
        <div class="dial"><slot name="score"></slot></div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dwc-verdict-banner': DwcVerdictBanner;
  }
}
