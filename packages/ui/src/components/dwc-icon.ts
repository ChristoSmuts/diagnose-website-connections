import { LitElement, css, html, svg, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { ICON_VIEWBOX, ICONS, type IconName } from '../icons/generated.js';
import { sharedStyles } from '../styles/shared.js';

export type { IconName };
export type IconWeight = 'regular' | 'fill' | 'duotone';

/**
 * Inline SVG icons, compiled from Phosphor at build time.
 *
 * `scripts/build-icons.mjs` extracts only the names listed in
 * `icons.manifest.json`, so @phosphor-icons/core stays a devDependency and no
 * consumer of this library inherits it. The result is inline SVG — no icon font,
 * no sprite fetch — which is what lets `currentColor` work through shadow DOM.
 *
 * Phosphor's geometry differs from a stroke-based set in two ways that shape this
 * component: the grid is 256×256, and paths are FILLED rather than stroked. There
 * is therefore no stroke-width to vary — `weight` selects different path data.
 *
 * Duotone is the interesting one. It has a rear layer that Phosphor ships at a
 * fixed 20% opacity; codegen strips that, so the rear tone is controlled here via
 * `--dwc-icon-back` and can be set to the verdict's own colour rather than a
 * permanent grey.
 *
 * Accessibility is unchanged from the hand-drawn version, because it was right:
 * icons are decorative (`aria-hidden`) by default, and supplying a `label`
 * promotes the icon to `role="img"` with a `<title>`.
 */
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
      /* Filled paths, never stroked — see the note above. */
      .front {
        fill: currentColor;
      }
      /*
       * The rear duotone layer. Defaults to a faint wash of the current colour,
       * matching Phosphor's own look, but a caller can point --dwc-icon-back at
       * any token — which is how the verdict hero tints its icon.
       */
      .back {
        fill: var(--dwc-icon-back, currentColor);
        opacity: var(--dwc-icon-back-opacity, 0.2);
      }
    `,
  ];

  @property({ type: String })
  accessor name: IconName = 'info';

  @property({ type: String, reflect: true })
  accessor weight: IconWeight = 'regular';

  /** Supplying a label promotes the icon from decoration to content. */
  @property({ type: String })
  accessor label = '';

  override render(): TemplateResult {
    const entry = ICONS[this.name] ?? ICONS.info;

    /*
     * Falls back to `regular`, which every icon has, when a weight was not
     * generated for this name. Silently rendering nothing would be worse: an
     * invisible icon is far harder to notice than a slightly wrong one, and the
     * manifest deliberately generates fill/duotone only where they are used.
     */
    const geometry =
      (entry as Partial<Record<IconWeight, { front: string; back?: string }>>)[this.weight] ??
      entry.regular;

    const decorative = this.label === '';
    const back = 'back' in geometry ? geometry.back : undefined;

    return html`
      <svg
        viewBox=${ICON_VIEWBOX}
        role=${decorative ? 'presentation' : 'img'}
        aria-hidden=${decorative ? 'true' : 'false'}
        focusable="false"
      >
        ${decorative ? null : svg`<title>${this.label}</title>`}
        ${back === undefined ? null : svg`<path class="back" d=${back} />`}
        ${svg`<path class="front" d=${geometry.front} />`}
      </svg>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dwc-icon': DwcIcon;
  }
}
