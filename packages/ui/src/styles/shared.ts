import { css, unsafeCSS, type CSSResult } from 'lit';
import { TAILWIND_CSS } from './generated.js';

/**
 * The one shared stylesheet every component adopts.
 *
 * Created exactly once at module scope, deliberately. Lit turns each CSSResult
 * into a constructable CSSStyleSheet and adopts it by reference, so a single
 * instance means the browser parses this sheet once and shares it across every
 * shadow root in the page — rather than every component paying for its own copy.
 *
 * Exported as an array so components can write:
 *   static styles = [...sharedStyles, css`…`]
 */
export const tailwindSheet: CSSResult = unsafeCSS(TAILWIND_CSS);

/**
 * Utilities that are awkward to express as Tailwind classes, or that we want
 * available to every component without repetition.
 */
export const baseSheet = css`
  /* Screen-reader-only text. Used heavily: every chart in this library carries a
     text equivalent, because an SVG waterfall is meaningless to a screen reader. */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border-width: 0;
  }

  /* Every interactive element meets the minimum comfortable touch size, even
     when it looks smaller — mobile-first means this is not optional. */
  .tap {
    min-width: var(--dwc-tap-target);
    min-height: var(--dwc-tap-target);
  }
`;

export const sharedStyles: readonly CSSResult[] = [tailwindSheet, baseSheet];
