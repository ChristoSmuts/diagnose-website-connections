import { LitElement, css, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { sharedStyles } from '../styles/shared.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/**
 * A button.
 *
 * Renders a real `<button>` inside the shadow root rather than styling a div, so
 * keyboard activation, form semantics and screen-reader announcement all come
 * for free instead of being reimplemented badly.
 */
@customElement('dwc-button')
export class DwcButton extends LitElement {
  static override styles = [
    ...sharedStyles,
    css`
      :host {
        display: inline-flex;
      }
      :host([full]) {
        display: flex;
        width: 100%;
      }

      button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: var(--dwc-space-2);
        width: 100%;
        /* Comfortably tappable on a phone; the visual size is set by padding. */
        min-height: var(--dwc-tap-target);
        padding: var(--dwc-space-2) var(--dwc-space-4);
        border-radius: var(--dwc-radius);
        border: 1px solid transparent;
        font-family: inherit;
        font-size: var(--dwc-text-sm);
        font-weight: var(--dwc-weight-medium);
        line-height: 1.4;
        cursor: pointer;
        transition:
          background-color var(--dwc-duration-fast) var(--dwc-ease),
          border-color var(--dwc-duration-fast) var(--dwc-ease),
          transform var(--dwc-duration-fast) var(--dwc-ease);
      }

      button:active:not(:disabled) {
        /* Tiny, but it makes the control feel physical. Disabled under
           prefers-reduced-motion via the duration tokens. */
        transform: translateY(1px);
      }

      button:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }

      .primary {
        background: var(--dwc-brand);
        color: var(--dwc-text-inverse);
      }
      .primary:hover:not(:disabled) {
        background: var(--dwc-brand-hover);
      }

      .secondary {
        background: var(--dwc-surface-raised);
        border-color: var(--dwc-border-strong);
        color: var(--dwc-text);
      }
      .secondary:hover:not(:disabled) {
        background: var(--dwc-surface-hover);
      }

      .ghost {
        background: transparent;
        color: var(--dwc-text-muted);
      }
      .ghost:hover:not(:disabled) {
        background: var(--dwc-surface-hover);
        color: var(--dwc-text);
      }

      .danger {
        background: var(--dwc-bad);
        color: var(--dwc-text-inverse);
      }
      .danger:hover:not(:disabled) {
        filter: brightness(0.92);
      }

      :host([size='sm']) button {
        min-height: 2rem;
        padding: var(--dwc-space-1) var(--dwc-space-3);
        font-size: var(--dwc-text-xs);
      }
      :host([size='lg']) button {
        min-height: 3rem;
        padding: var(--dwc-space-3) var(--dwc-space-6);
        font-size: var(--dwc-text-base);
      }

      .spinner {
        width: 1em;
        height: 1em;
        border: 2px solid currentColor;
        border-right-color: transparent;
        border-radius: var(--dwc-radius-full);
        animation: spin 700ms linear infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .spinner {
          animation-duration: 2.5s;
        }
      }
    `,
  ];

  @property({ type: String, reflect: true })
  accessor variant: ButtonVariant = 'secondary';

  @property({ type: String, reflect: true })
  accessor size: 'sm' | 'md' | 'lg' = 'md';

  @property({ type: Boolean, reflect: true })
  accessor disabled = false;

  @property({ type: Boolean, reflect: true })
  accessor full = false;

  /** Shows a spinner and blocks activation, without changing the button's width. */
  @property({ type: Boolean })
  accessor loading = false;

  @property({ type: String })
  accessor type: 'button' | 'submit' = 'button';

  /** Required when the button's only content is an icon. */
  @property({ type: String, attribute: 'aria-label' })
  accessor ariaLabelText: string | null = null;

  override render(): TemplateResult {
    return html`
      <button
        class=${this.variant}
        type=${this.type}
        ?disabled=${this.disabled || this.loading}
        aria-label=${this.ariaLabelText ?? undefined}
        aria-busy=${this.loading ? 'true' : 'false'}
      >
        ${this.loading ? html`<span class="spinner" aria-hidden="true"></span>` : null}
        <slot></slot>
      </button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dwc-button': DwcButton;
  }
}
