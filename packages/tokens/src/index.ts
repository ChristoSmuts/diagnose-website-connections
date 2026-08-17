/**
 * Typed accessors for the tokens declared in tokens.css.
 *
 * The CSS file is the single source of truth for values; this module exists so
 * TypeScript can refer to token *names* without stringly-typed guesswork, and so
 * a rename produces a compile error rather than a silently broken style.
 */

export type ThemeChoice = 'light' | 'dark' | 'system';

/** Semantic status shared by verdicts, vantage tiles and badges. */
export type StatusTone = 'ok' | 'warn' | 'bad' | 'unknown' | 'info' | 'brand';

/** Custom-property name for a tone's foreground/background/border set. */
export const tone = (name: StatusTone) =>
  ({
    base: `var(--dwc-${name})`,
    subtle: `var(--dwc-${name}-subtle)`,
    border: `var(--dwc-${name}-border)`,
    text: `var(--dwc-${name}-text)`,
  }) as const;

export const THEME_STORAGE_KEY = 'dwc-theme';

/**
 * Apply a theme choice to the document.
 *
 * 'system' removes the attribute entirely rather than writing a value, which is
 * what lets the `prefers-color-scheme` media query take over again. Writing
 * data-theme="system" would match neither themed selector and silently pin the
 * page to light.
 */
export function applyTheme(choice: ThemeChoice, root: HTMLElement): void {
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

export function readStoredTheme(storage: Pick<Storage, 'getItem'>): ThemeChoice {
  const raw = storage.getItem(THEME_STORAGE_KEY);
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

/** What the user will actually see, resolving 'system' against the OS. */
export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): 'light' | 'dark' {
  if (choice !== 'system') return choice;
  return prefersDark ? 'dark' : 'light';
}
