import { LitElement, css, html, svg, type SVGTemplateResult, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { sharedStyles } from '../styles/shared.js';

/**
 * Inline SVG icons.
 *
 * Hand-drawn on a 24px grid rather than pulled from a library, because the brief
 * is explicitly no third-party UI dependencies — and because a handful of icons
 * is far cheaper than a font or an icon package.
 *
 * Every icon is decorative by default (`aria-hidden`). Where an icon carries
 * meaning on its own, the caller passes a `label` and it becomes an img role.
 */
const PATHS: Record<string, SVGTemplateResult> = {
  check: svg`<path d="M20 6 9 17l-5-5" />`,
  warning: svg`<path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />`,
  error: svg`<circle cx="12" cy="12" r="9" /><path d="M15 9l-6 6m0-6 6 6" />`,
  question: svg`<circle cx="12" cy="12" r="9" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3m.1 4h.01" />`,
  info: svg`<circle cx="12" cy="12" r="9" /><path d="M12 16v-4m0-4h.01" />`,
  server: svg`<rect x="2" y="3" width="20" height="8" rx="2" /><rect x="2" y="13" width="20" height="8" rx="2" /><path d="M6 7h.01M6 17h.01" />`,
  wifi: svg`<path d="M5 12.55a11 11 0 0 1 14 0M2 8.82a16 16 0 0 1 20 0M8.5 16.4a6 6 0 0 1 7 0M12 20h.01" />`,
  route: svg`<circle cx="6" cy="19" r="3" /><circle cx="18" cy="5" r="3" /><path d="M9 19h5a4 4 0 0 0 0-8h-4a4 4 0 0 1 0-8h5" />`,
  chevron: svg`<path d="m9 18 6-6-6-6" />`,
  plus: svg`<path d="M12 5v14m-7-7h14" />`,
  search: svg`<circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />`,
  archive: svg`<rect x="2" y="4" width="20" height="5" rx="1" /><path d="M4 9v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9M10 13h4" />`,
  trash: svg`<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />`,
  restore: svg`<path d="M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5" />`,
  refresh: svg`<path d="M21 12a9 9 0 1 1-3-6.7L21 8m0-5v5h-5" />`,
  download: svg`<path d="M12 3v12m0 0 4-4m-4 4-4-4M3 17v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2" />`,
  print: svg`<path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="8" rx="1" />`,
  sun: svg`<circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />`,
  moon: svg`<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />`,
  monitor: svg`<rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8m-4-4v4" />`,
  menu: svg`<path d="M3 6h18M3 12h18M3 18h18" />`,
  close: svg`<path d="M18 6 6 18M6 6l12 12" />`,
  copy: svg`<rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />`,
  pencil: svg`<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />`,
  globe: svg`<circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18Z" />`,
};

export type IconName = keyof typeof PATHS;

@customElement('dwc-icon')
export class DwcIcon extends LitElement {
  static override styles = [
    ...sharedStyles,
    css`
      :host {
        display: inline-flex;
        flex: none;
        /* Follows font-size by default, so icons scale with their text. */
        width: var(--dwc-icon-size, 1.25em);
        height: var(--dwc-icon-size, 1.25em);
        color: inherit;
      }
      svg {
        width: 100%;
        height: 100%;
        display: block;
      }
    `,
  ];

  @property({ type: String })
  accessor name: IconName = 'info';

  /** Supplying a label promotes the icon from decoration to content. */
  @property({ type: String })
  accessor label = '';

  override render(): TemplateResult {
    const path = PATHS[this.name] ?? PATHS.info;
    return html`
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
        role=${this.label === '' ? 'presentation' : 'img'}
        aria-hidden=${this.label === '' ? 'true' : 'false'}
      >
        ${this.label === '' ? null : svg`<title>${this.label}</title>`} ${path}
      </svg>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dwc-icon': DwcIcon;
  }
}
