/**
 * Entry point.
 *
 * The token sheet is imported once here at document level. Components never
 * import it themselves: custom properties inherit through shadow boundaries, so
 * one document-level sheet themes the entire tree.
 */
import '@dwc/tokens/tokens.css';
import './global.css';
import './app.js';
