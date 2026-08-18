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
    /* Modern equivalent of 'clip', which is deprecated. Both are kept: the old
       one for browsers that ignore clip-path, the new one because clip alone did
       not stop the box below from contributing to scrollable overflow. */
    clip-path: inset(50%);
    white-space: nowrap;
    border-width: 0;
  }

  /*
   * Tables need the extra rule, and this was a real bug rather than pedantry.
   *
   * A table's used width has its min-content width as a floor, so 'width: 1px'
   * was quietly ignored and the waterfall's hidden data table laid out at its
   * natural 981px. Invisible, correctly, but still part of the document's
   * scrollable area — which is what made every report scroll sideways on a phone.
   * Fixed layout makes the declared width the used one.
   */
  table.sr-only {
    table-layout: fixed;
    max-width: 1px;
  }

  /* Every interactive element meets the minimum comfortable touch size, even
     when it looks smaller — mobile-first means this is not optional. */
  .tap {
    min-width: var(--dwc-tap-target);
    min-height: var(--dwc-tap-target);
  }
`;

/**
 * Shared visual primitives — the layer that carries the design's character.
 *
 * These live here rather than in each component for a specific reason: this array
 * is adopted **by reference** into every shadow root, so the browser parses these
 * rules once and shares one CSSStyleSheet across the whole page. Adding a class
 * here upgrades all thirteen components at no per-component cost, and keeps the
 * elevation and motion language consistent instead of thirteen near-identical
 * box-shadow declarations drifting apart.
 *
 * Two conventions everything below relies on:
 *
 *  - **Tone in, colour out.** Components set `--tone-base` (and optionally
 *    `--tone-subtle` / `--tone-border`) to a semantic token, and these rules mix
 *    it with the surface. One recipe therefore serves every verdict colour and
 *    adapts to the theme, instead of a gradient per tone per theme.
 *  - **Motion is opt-in, not opt-out.** Every animation sits inside
 *    `@media (prefers-reduced-motion: no-preference)`, so the reduced-motion path
 *    is the *absence* of a rule. A per-component override could be forgotten;
 *    this cannot.
 */
export const surfaceSheet = css`
  /*
   * A surface that reads as a physical object rather than a drawn rectangle.
   *
   * The inset highlight along the top edge is what does the work — a hairline of
   * light where the surface catches it. Without it, a card is a border and a fill;
   * with it, the card has an edge.
   */
  .card {
    position: relative;
    border: 1px solid var(--dwc-border);
    border-radius: var(--dwc-radius-lg);
    background: var(--dwc-surface-raised);
    box-shadow:
      inset 0 1px 0 var(--dwc-highlight),
      var(--dwc-shadow-sm);
  }

  .card-lg {
    border-radius: var(--dwc-radius-xl);
    box-shadow:
      inset 0 1px 0 var(--dwc-highlight),
      var(--dwc-shadow-md);
  }

  /* Sunken variant, for evidence tables and code — reads as inset, not raised. */
  .well {
    border: 1px solid var(--dwc-border);
    border-radius: var(--dwc-radius);
    background: var(--dwc-surface-sunken);
    box-shadow: inset 0 1px 2px var(--dwc-ring-subtle);
  }

  /*
   * Ambient tone wash, driven by whatever --tone-base is in scope.
   *
   * A pseudo-element rather than a background on the host, so it can sit *under*
   * content without becoming a stacking-context problem for it — and, more
   * importantly, so text never inherits a gradient as its own background. Body
   * copy on top of this always has an opaque layer between.
   */
  .wash {
    position: relative;
    isolation: isolate;
    overflow: hidden;
  }
  .wash::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    background:
      radial-gradient(
        120% 100% at 0% 0%,
        color-mix(
          in oklab,
          var(--tone-base, var(--dwc-brand)) var(--dwc-wash-strength),
          transparent
        ),
        transparent 70%
      ),
      var(--dwc-surface-raised);
  }

  /* Soft coloured bloom, for the hero and the score dial. Decorative only. */
  .glow::after {
    content: '';
    position: absolute;
    inset: -20%;
    z-index: -1;
    pointer-events: none;
    background: radial-gradient(
      closest-side,
      color-mix(in oklab, var(--tone-base, var(--dwc-brand)) var(--dwc-glow-strength), transparent),
      transparent
    );
  }

  /* The status/severity accent bar used by tiles, findings, checks and nav. */
  .rail {
    position: absolute;
    inset: 0 auto 0 0;
    width: 3px;
    border-radius: inherit;
    background: var(--tone-base, var(--dwc-border-strong));
  }

  /*
   * Numeric readouts.
   *
   * tabular-nums is the load-bearing part, not decoration: these numbers update
   * live as results stream in, and proportional digits make the whole row twitch
   * sideways on every change.
   */
  .num {
    font-family: var(--dwc-font-display);
    font-variant-numeric: tabular-nums;
    letter-spacing: var(--dwc-tracking-tight);
    font-weight: var(--dwc-weight-semibold);
  }

  /* Values rather than prose: headers, ciphers, addresses, sizes. */
  .mono {
    font-family: var(--dwc-font-mono);
    font-variant-numeric: tabular-nums;
    font-size: 0.9375em;
  }

  /* Small uppercase section label. */
  .eyebrow {
    font-size: var(--dwc-text-xs);
    font-weight: var(--dwc-weight-semibold);
    text-transform: uppercase;
    letter-spacing: var(--dwc-tracking-wide);
    color: var(--dwc-text-subtle);
  }

  .display {
    font-family: var(--dwc-font-display);
    font-weight: var(--dwc-weight-bold);
    line-height: var(--dwc-leading-tight);
    letter-spacing: var(--dwc-tracking-tight);
    text-wrap: balance;
  }

  @media (prefers-reduced-motion: no-preference) {
    /* Interactive lift. Kept to 1px: enough to feel, not enough to nudge text. */
    .lift {
      transition:
        transform var(--dwc-duration-fast) var(--dwc-ease-out),
        box-shadow var(--dwc-duration-fast) var(--dwc-ease-out),
        border-color var(--dwc-duration-fast) var(--dwc-ease-out);
    }
    .lift:hover {
      transform: translateY(-1px);
      box-shadow:
        inset 0 1px 0 var(--dwc-highlight),
        var(--dwc-shadow-md);
    }

    /*
     * Entrance for streamed results. Staggered by setting --i on each item, so a
     * report assembles itself rather than snapping in as a block.
     */
    .rise {
      animation: dwc-rise var(--dwc-duration-slow) var(--dwc-ease-out) backwards;
      animation-delay: calc(var(--i, 0) * 55ms);
    }

    .shimmer {
      background-image: linear-gradient(
        90deg,
        transparent,
        color-mix(in oklab, var(--dwc-text) 7%, transparent),
        transparent
      );
      background-size: 200% 100%;
      animation: dwc-shimmer 1.4s ease-in-out infinite;
    }

    .spin {
      animation: dwc-spin 900ms linear infinite;
    }
  }

  @keyframes dwc-rise {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @keyframes dwc-shimmer {
    from {
      background-position: 200% 0;
    }
    to {
      background-position: -200% 0;
    }
  }

  @keyframes dwc-spin {
    to {
      transform: rotate(360deg);
    }
  }
`;

export const sharedStyles: readonly CSSResult[] = [tailwindSheet, baseSheet, surfaceSheet];
