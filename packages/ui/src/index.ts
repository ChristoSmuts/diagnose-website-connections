/**
 * @dwc/ui — Lit component library.
 *
 * Every component keeps a real shadow root and is themed entirely through CSS
 * custom properties, which inherit across the shadow boundary. That is what
 * makes these safe to drop into another application in the ecosystem: no styles
 * leak in, none leak out, and theming needs no piercing selectors.
 *
 * Consumers must load the token sheet once, at the document level:
 *   import '@dwc/ui/tokens.css';
 */

export { DwcBadge } from './components/dwc-badge.js';
export { DwcButton, type ButtonVariant } from './components/dwc-button.js';
export { DwcDialog } from './components/dwc-dialog.js';
export { DwcFindingCard } from './components/dwc-finding-card.js';
export { DwcIcon, type IconName } from './components/dwc-icon.js';
export { DwcNavTree } from './components/dwc-nav-tree.js';
export { DwcProgressSteps, type ProgressStep } from './components/dwc-progress-steps.js';
export { DwcScoreDial } from './components/dwc-score-dial.js';
export { DwcThemeToggle } from './components/dwc-theme-toggle.js';
export { DwcUrlInput } from './components/dwc-url-input.js';
export { DwcVantageTile } from './components/dwc-vantage-tile.js';
export { DwcVerdictBanner } from './components/dwc-verdict-banner.js';
export { DwcWaterfall, type WaterfallPhase } from './components/dwc-waterfall.js';

export { sharedStyles, tailwindSheet, baseSheet } from './styles/shared.js';
export { formatWhen, formatBytes } from './utils/format.js';
