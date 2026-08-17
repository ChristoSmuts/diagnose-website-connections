import { LitElement, css, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { StatusTone } from '@dwc/tokens';
import { sharedStyles } from '../styles/shared.js';

/**
 * A small status pill.
 *
 * Always renders a text label alongside its colour. Colour is never the only
 * carrier of meaning here — that is a WCAG requirement, and it is also simply
 * what makes a report readable to the roughly one in twelve men with a colour
 * vision deficiency.
 */
@customElement('dwc-badge')
export class DwcBadge extends LitElement {
  static override styles = [
    ...sharedStyles,
    css`
      :host {
        display: inline-flex;
      }

      .badge {
        display: inline-flex;
        align-items: center;
        gap: var(--dwc-space-1);
        padding: 0.125rem var(--dwc-space-2);
        border-radius: var(--dwc-radius-full);
        border: 1px solid var(--tone-border);
        background: var(--tone-subtle);
        color: var(--tone-text);
        font-size: var(--dwc-text-xs);
        font-weight: var(--dwc-weight-medium);
        line-height: 1.5;
        white-space: nowrap;
      }

      .dot {
        width: 0.375rem;
        height: 0.375rem;
        border-radius: var(--dwc-radius-full);
        background: var(--tone-base);
        flex: none;
      }

      :host([size='lg']) .badge {
        font-size: var(--dwc-text-sm);
        padding: var(--dwc-space-1) var(--dwc-space-3);
      }
    `,
  ];

  /** Semantic colour. Paired with the label text, never used alone. */
  @property({ type: String, reflect: true })
  accessor tone: StatusTone = 'unknown';

  @property({ type: String, reflect: true })
  accessor size: 'sm' | 'lg' = 'sm';

  /** Show the leading dot. Purely decorative, so it is aria-hidden. */
  @property({ type: Boolean })
  accessor dot = false;

  override render(): TemplateResult {
    return html`
      <span
        class="badge"
        style="--tone-base: var(--dwc-${this.tone}); --tone-subtle: var(--dwc-${this.tone}-subtle); --tone-border: var(--dwc-${this.tone}-border); --tone-text: var(--dwc-${this.tone}-text);"
      >
        ${this.dot ? html`<span class="dot" aria-hidden="true"></span>` : null}
        <slot></slot>
      </span>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dwc-badge': DwcBadge;
  }
}
