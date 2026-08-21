import { LitElement, css, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { sharedStyles } from '../styles/shared.js';

/**
 * An on/off control for a setting the reader chooses before running something.
 *
 * A switch rather than a checkbox, and the distinction is not cosmetic: a
 * checkbox states a fact that is submitted later, a switch changes something
 * now. The throughput test is the second kind — nothing is submitted, the probe
 * simply reads the value when it gets there.
 *
 * Built on a real `<button>` so Space and Enter both activate it, focus order is
 * the browser's, and the global focus-ring rule in the shared sheet applies
 * without this component restating it. `role="switch"` is a button that carries
 * `aria-checked`, which is exactly what this is.
 *
 * The hit area is `--dwc-tap-target` tall even though the track is smaller. The
 * checkbox this replaced was 1.1rem — under half the size the rest of the app
 * holds itself to, and the one control on the landing page most likely to be
 * reached for on a phone.
 */
@customElement('dwc-switch')
export class DwcSwitch extends LitElement {
  static override styles = [
    ...sharedStyles,
    css`
      :host {
        display: inline-flex;
      }

      button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        /* The track is 1.5rem tall; the button is bigger so the target is not. */
        min-height: var(--dwc-tap-target);
        min-width: var(--dwc-tap-target);
        padding: 0;
        border: none;
        background: transparent;
        cursor: pointer;
      }

      button[disabled] {
        cursor: not-allowed;
        opacity: 0.5;
      }

      .track {
        position: relative;
        display: block;
        width: 2.25rem;
        height: 1.3rem;
        border-radius: var(--dwc-radius-full);
        border: 1px solid var(--dwc-border-strong);
        background: var(--dwc-surface-sunken);
        transition:
          background-color var(--dwc-duration-fast) var(--dwc-ease),
          border-color var(--dwc-duration-fast) var(--dwc-ease);
      }

      button:hover:not([disabled]) .track {
        border-color: var(--dwc-brand-border);
      }

      button[aria-checked='true'] .track {
        background: var(--dwc-brand);
        border-color: var(--dwc-brand);
      }

      .thumb {
        position: absolute;
        top: 50%;
        left: 2px;
        width: 0.95rem;
        height: 0.95rem;
        transform: translate(0, -50%);
        border-radius: var(--dwc-radius-full);
        background: var(--dwc-surface-raised);
        box-shadow: var(--dwc-shadow-sm);
        transition: transform var(--dwc-duration-fast) var(--dwc-ease-out);
      }

      button[aria-checked='true'] .thumb {
        /* Track width, less the thumb and both insets. */
        transform: translate(0.95rem, -50%);
      }

      /* The thumb position carries the state visually, so it must still be
         readable when the colour difference is not — forced-colours strips the
         brand fill entirely. */
      @media (forced-colors: active) {
        .track {
          border-color: ButtonText;
        }

        button[aria-checked='true'] .track {
          background: Highlight;
        }
      }
    `,
  ];

  /** Reflected so the host can be styled and queried on state. */
  @property({ type: Boolean, reflect: true })
  accessor checked = false;

  @property({ type: Boolean, reflect: true })
  accessor disabled = false;

  /**
   * The accessible name.
   *
   * A plain string rather than `aria-labelledby`, which cannot cross a shadow
   * boundary to reach the label text living in the consuming component.
   */
  @property({ type: String, attribute: 'aria-label' })
  accessor ariaLabelText = 'Toggle';

  private toggle(): void {
    if (this.disabled) return;
    this.checked = !this.checked;
    this.dispatchEvent(
      new CustomEvent('change', {
        detail: { checked: this.checked },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Flips the switch from outside, e.g. a click on the surrounding row. */
  toggleFromHost(): void {
    this.toggle();
  }

  override render(): TemplateResult {
    return html`
      <button
        type="button"
        role="switch"
        aria-checked=${this.checked ? 'true' : 'false'}
        aria-label=${this.ariaLabelText}
        ?disabled=${this.disabled}
        @click=${this.toggle}
      >
        <span class="track"><span class="thumb"></span></span>
      </button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dwc-switch': DwcSwitch;
  }
}
