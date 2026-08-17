import { LitElement, css, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { ThemeChoice } from '@dwc/tokens';
import { sharedStyles } from '../styles/shared.js';
import './dwc-icon.js';

/**
 * Light / dark / follow-the-system.
 *
 * Three explicit states rather than a two-way switch, because "follow my
 * system" is a real preference and a binary toggle silently overrides it the
 * first time it is touched.
 *
 * Implemented as a radiogroup so arrow keys move between options, which is what
 * a keyboard user expects from a segmented control.
 */
@customElement('dwc-theme-toggle')
export class DwcThemeToggle extends LitElement {
  static override styles = [
    ...sharedStyles,
    css`
      :host {
        display: inline-flex;
      }

      .group {
        display: inline-flex;
        gap: 2px;
        padding: 2px;
        border-radius: var(--dwc-radius-full);
        border: 1px solid var(--dwc-border);
        background: var(--dwc-surface-sunken);
      }

      button {
        display: grid;
        place-items: center;
        width: 2rem;
        height: 2rem;
        border: none;
        border-radius: var(--dwc-radius-full);
        background: transparent;
        color: var(--dwc-text-subtle);
        cursor: pointer;
        --dwc-icon-size: 1rem;
        transition:
          background-color var(--dwc-duration-fast) var(--dwc-ease),
          color var(--dwc-duration-fast) var(--dwc-ease);
      }

      button:hover {
        color: var(--dwc-text);
      }

      button[aria-checked='true'] {
        background: var(--dwc-surface-raised);
        color: var(--dwc-brand);
        box-shadow: var(--dwc-shadow-sm);
      }
    `,
  ];

  @property({ type: String })
  accessor choice: ThemeChoice = 'system';

  private select(choice: ThemeChoice): void {
    this.choice = choice;
    this.dispatchEvent(
      new CustomEvent('theme-change', { detail: { choice }, bubbles: true, composed: true }),
    );
  }

  private onKeydown(event: KeyboardEvent): void {
    const order: ThemeChoice[] = ['light', 'system', 'dark'];
    const index = order.indexOf(this.choice);
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      this.select(order[(index + 1) % order.length] ?? 'system');
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.select(order[(index - 1 + order.length) % order.length] ?? 'system');
    }
  }

  override render(): TemplateResult {
    const options: { value: ThemeChoice; icon: string; label: string }[] = [
      { value: 'light', icon: 'sun', label: 'Light' },
      { value: 'system', icon: 'monitor', label: 'Match my system' },
      { value: 'dark', icon: 'moon', label: 'Dark' },
    ];

    return html`
      <div class="group" role="radiogroup" aria-label="Colour theme" @keydown=${this.onKeydown}>
        ${options.map(
          (option) => html`
            <button
              type="button"
              role="radio"
              aria-checked=${this.choice === option.value ? 'true' : 'false'}
              aria-label=${option.label}
              title=${option.label}
              tabindex=${this.choice === option.value ? '0' : '-1'}
              @click=${() => this.select(option.value)}
            >
              <dwc-icon name=${option.icon}></dwc-icon>
            </button>
          `,
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dwc-theme-toggle': DwcThemeToggle;
  }
}
