import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { sharedStyles } from '../styles/shared.js';
import './dwc-button.js';
import './dwc-icon.js';

/**
 * The primary entry point: type an address, get a diagnostic.
 *
 * Deliberately forgiving — "example.com" is what people type, so the scheme is
 * optional and whitespace is trimmed. Validation is left to the server, which
 * owns the real rules (including the SSRF denylist); this only catches obviously
 * empty input so the user is not told off for something the server would accept.
 */
@customElement('dwc-url-input')
export class DwcUrlInput extends LitElement {
  static override styles = [
    ...sharedStyles,
    css`
      :host {
        display: block;
      }

      form {
        display: flex;
        flex-direction: column;
        gap: var(--dwc-space-2);
      }

      /* Side-by-side once there is room, stacked on a phone. A container query
         rather than a media query, so the component behaves correctly wherever
         it is placed — including inside a narrow sidebar. */
      @container (min-width: 32rem) {
        form {
          flex-direction: row;
        }
      }

      .field {
        position: relative;
        display: flex;
        align-items: center;
        flex: 1;
      }

      .leading {
        position: absolute;
        left: var(--dwc-space-3);
        display: grid;
        place-items: center;
        color: var(--dwc-text-subtle);
        pointer-events: none;
        --dwc-icon-size: 1.125rem;
      }

      input {
        width: 100%;
        min-height: var(--dwc-tap-target);
        padding: var(--dwc-space-3) var(--dwc-space-4) var(--dwc-space-3) var(--dwc-space-10);
        border: 1px solid var(--dwc-border-strong);
        border-radius: var(--dwc-radius);
        background: var(--dwc-surface-raised);
        color: var(--dwc-text);
        font: inherit;
        font-size: var(--dwc-text-base);
        transition: border-color var(--dwc-duration-fast) var(--dwc-ease);
      }
      input::placeholder {
        color: var(--dwc-text-subtle);
      }
      input:hover:not(:disabled) {
        border-color: var(--dwc-brand-border);
      }
      input:disabled {
        opacity: 0.6;
      }
      input[aria-invalid='true'] {
        border-color: var(--dwc-bad);
      }

      .error {
        display: flex;
        align-items: center;
        gap: var(--dwc-space-1);
        font-size: var(--dwc-text-sm);
        color: var(--dwc-bad-text);
      }
    `,
  ];

  @property({ type: String })
  accessor value = '';

  @property({ type: Boolean })
  accessor busy = false;

  @property({ type: String })
  accessor placeholder = 'example.com';

  @property({ type: String, attribute: 'button-label' })
  accessor buttonLabel = 'Run diagnostic';

  /** Server-side error, surfaced next to the field it refers to. */
  @property({ type: String })
  accessor error: string | null = null;

  @state()
  private accessor localError: string | null = null;

  @query('input')
  private accessor input!: HTMLInputElement;

  private submit(event: Event): void {
    event.preventDefault();
    const raw = this.input.value.trim();

    if (raw.length === 0) {
      this.localError = 'Enter a website address to check.';
      this.input.focus();
      return;
    }

    this.localError = null;
    this.value = raw;
    this.dispatchEvent(
      new CustomEvent('diagnose', { detail: { url: raw }, bubbles: true, composed: true }),
    );
  }

  override render(): TemplateResult {
    const message = this.error ?? this.localError;
    const errorId = 'url-error';

    return html`
      <form @submit=${this.submit} novalidate>
        <div class="field">
          <span class="leading"><dwc-icon name="globe"></dwc-icon></span>
          <input
            type="text"
            inputmode="url"
            autocomplete="url"
            spellcheck="false"
            autocapitalize="off"
            .value=${this.value}
            placeholder=${this.placeholder}
            aria-label="Website address to check"
            aria-invalid=${message === null ? 'false' : 'true'}
            aria-describedby=${message === null ? undefined : errorId}
            ?disabled=${this.busy}
            @input=${() => {
              this.localError = null;
            }}
          />
        </div>

        <dwc-button variant="primary" size="lg" type="submit" ?loading=${this.busy}>
          ${this.busy ? 'Checking…' : this.buttonLabel}
        </dwc-button>
      </form>

      ${
        message === null
          ? nothing
          : html`
              <p class="error" id=${errorId} role="alert">
                <dwc-icon name="warning"></dwc-icon>${message}
              </p>
            `
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dwc-url-input': DwcUrlInput;
  }
}
