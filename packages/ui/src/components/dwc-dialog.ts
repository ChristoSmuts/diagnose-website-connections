import { LitElement, css, html, type TemplateResult } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { sharedStyles } from '../styles/shared.js';
import './dwc-button.js';

/**
 * Modal dialog, used for confirming anything irreversible.
 *
 * Built on the native `<dialog>` element rather than a hand-rolled overlay: it
 * gives focus trapping, Escape-to-close, inert background content and the top
 * layer for free — all things that are routinely got wrong when reimplemented,
 * and that a keyboard or screen-reader user depends on completely.
 */
@customElement('dwc-dialog')
export class DwcDialog extends LitElement {
  static override styles = [
    ...sharedStyles,
    css`
      dialog {
        width: min(28rem, calc(100vw - 2rem));
        padding: 0;
        border: 1px solid var(--dwc-border);
        border-radius: var(--dwc-radius-lg);
        background: var(--dwc-surface-raised);
        color: var(--dwc-text);
        box-shadow: var(--dwc-shadow-lg);
      }

      dialog::backdrop {
        background: oklch(0% 0 0 / 0.45);
        backdrop-filter: blur(2px);
      }

      .content {
        display: grid;
        gap: var(--dwc-space-3);
        padding: var(--dwc-space-5);
      }

      h2 {
        margin: 0;
        font-size: var(--dwc-text-lg);
        font-weight: var(--dwc-weight-semibold);
        color: var(--dwc-text);
      }

      p {
        margin: 0;
        font-size: var(--dwc-text-sm);
        line-height: var(--dwc-leading-normal);
        color: var(--dwc-text-muted);
      }

      .actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--dwc-space-2);
        margin-top: var(--dwc-space-2);
      }
    `,
  ];

  @property({ type: Boolean })
  accessor open = false;

  @property({ type: String })
  accessor heading = '';

  @property({ type: String })
  accessor message = '';

  @property({ type: String, attribute: 'confirm-label' })
  accessor confirmLabel = 'Confirm';

  @property({ type: String, attribute: 'cancel-label' })
  accessor cancelLabel = 'Cancel';

  /** Styles the confirm action as destructive. */
  @property({ type: Boolean })
  accessor danger = false;

  @query('dialog')
  private accessor dialog!: HTMLDialogElement;

  override updated(changed: Map<string, unknown>): void {
    if (!changed.has('open')) return;

    if (this.open && !this.dialog.open) this.dialog.showModal();
    else if (!this.open && this.dialog.open) this.dialog.close();
  }

  private close(reason: 'cancel' | 'confirm'): void {
    this.open = false;
    this.dispatchEvent(new CustomEvent(reason, { bubbles: true, composed: true }));
  }

  override render(): TemplateResult {
    return html`
      <dialog
        aria-labelledby="dialog-heading"
        aria-describedby="dialog-message"
        @cancel=${(event: Event) => {
          // Fires on Escape. Intercepted so our own state stays in sync with
          // the element's, which would otherwise silently diverge.
          event.preventDefault();
          this.close('cancel');
        }}
      >
        <div class="content">
          <h2 id="dialog-heading">${this.heading}</h2>
          <p id="dialog-message">${this.message}</p>
          <slot></slot>

          <div class="actions">
            <dwc-button variant="ghost" @click=${() => this.close('cancel')}>
              ${this.cancelLabel}
            </dwc-button>
            <dwc-button
              variant=${this.danger ? 'danger' : 'primary'}
              @click=${() => this.close('confirm')}
            >
              ${this.confirmLabel}
            </dwc-button>
          </div>
        </div>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dwc-dialog': DwcDialog;
  }
}
