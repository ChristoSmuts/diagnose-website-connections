import { LitElement, css, html, type nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { sharedStyles } from '../styles/shared.js';
import './dwc-icon.js';

export interface ProgressStep {
  key: string;
  label: string;
  status: 'pending' | 'started' | 'complete' | 'skipped' | 'failed';
  message: string;
}

/**
 * Live progress while a diagnostic runs.
 *
 * A full probe legitimately takes several seconds, and watching real steps
 * complete is far better than a spinner — it shows the tool is doing specific,
 * legible work rather than merely waiting.
 *
 * The list is an aria-live region so the same information reaches screen-reader
 * users as it happens, rather than only appearing at the end.
 */
@customElement('dwc-progress-steps')
export class DwcProgressSteps extends LitElement {
  static override styles = [
    ...sharedStyles,
    css`
      :host {
        display: block;
      }

      ol {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: var(--dwc-space-1);
      }

      li {
        display: flex;
        align-items: center;
        gap: var(--dwc-space-3);
        padding: var(--dwc-space-2) var(--dwc-space-3);
        border-radius: var(--dwc-radius);
        font-size: var(--dwc-text-sm);
        color: var(--dwc-text-subtle);
        transition: background-color var(--dwc-duration) var(--dwc-ease);
      }

      li[data-status='started'] {
        background: var(--dwc-brand-subtle);
        color: var(--dwc-text);
      }
      li[data-status='complete'] {
        color: var(--dwc-text-muted);
      }
      li[data-status='failed'] {
        background: var(--dwc-bad-subtle);
        color: var(--dwc-bad-text);
      }

      .mark {
        display: grid;
        place-items: center;
        width: 1.25rem;
        height: 1.25rem;
        flex: none;
        --dwc-icon-size: 1rem;
      }

      .dot {
        width: 0.5rem;
        height: 0.5rem;
        border-radius: var(--dwc-radius-full);
        background: var(--dwc-border-strong);
      }

      .spinner {
        width: 0.875rem;
        height: 0.875rem;
        border: 2px solid var(--dwc-brand);
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

      .ok {
        color: var(--dwc-ok);
      }
      .fail {
        color: var(--dwc-bad);
      }

      .message {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ];

  @property({ type: Array })
  accessor steps: ProgressStep[] = [];

  override render(): TemplateResult {
    return html`
      <ol aria-live="polite" aria-atomic="false">
        ${this.steps.map(
          (step) => html`
            <li data-status=${step.status}>
              <span class="mark">${this.renderMark(step.status)}</span>
              <span class="message">${step.message === '' ? step.label : step.message}</span>
            </li>
          `,
        )}
      </ol>
    `;
  }

  private renderMark(status: ProgressStep['status']): TemplateResult | typeof nothing {
    switch (status) {
      case 'started':
        return html`<span class="spinner" aria-hidden="true"></span>`;
      case 'complete':
        return html`<dwc-icon class="ok" name="check" label="Done"></dwc-icon>`;
      case 'failed':
        return html`<dwc-icon class="fail" name="error" label="Failed"></dwc-icon>`;
      case 'skipped':
        return html`<span class="dot" aria-hidden="true"></span>`;
      default:
        return html`<span class="dot" aria-hidden="true"></span>`;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dwc-progress-steps': DwcProgressSteps;
  }
}
