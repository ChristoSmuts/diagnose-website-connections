import { describe, expect, it } from 'vitest';
import { applyTheme, readStoredTheme, resolveTheme } from './index.js';

/** Minimal stand-in for the one element method applyTheme touches. */
function fakeRoot(): HTMLElement & { attrs: Record<string, string> } {
  const attrs: Record<string, string> = {};
  return {
    attrs,
    setAttribute: (name: string, value: string) => {
      attrs[name] = value;
    },
    removeAttribute: (name: string) => {
      delete attrs[name];
    },
  } as unknown as HTMLElement & { attrs: Record<string, string> };
}

describe('theme application', () => {
  it('stamps an explicit choice onto the root', () => {
    const root = fakeRoot();
    applyTheme('dark', root);
    expect(root.attrs['data-theme']).toBe('dark');
  });

  /**
   * The subtle one. Writing data-theme="system" would match neither themed
   * selector, silently pinning the page to light and breaking "follow my OS".
   * Removing the attribute is what hands control back to the media query.
   */
  it('removes the attribute for "system" rather than writing a value', () => {
    const root = fakeRoot();
    applyTheme('dark', root);
    applyTheme('system', root);

    expect(root.attrs['data-theme']).toBeUndefined();
    expect('data-theme' in root.attrs).toBe(false);
  });
});

describe('stored preference', () => {
  const storage = (value: string | null) => ({ getItem: () => value });

  it('reads a valid stored choice', () => {
    expect(readStoredTheme(storage('dark'))).toBe('dark');
    expect(readStoredTheme(storage('light'))).toBe('light');
  });

  it('falls back to system for anything unexpected', () => {
    expect(readStoredTheme(storage(null))).toBe('system');
    expect(readStoredTheme(storage('neon'))).toBe('system');
    // "system" is never persisted as a value, but must round-trip safely.
    expect(readStoredTheme(storage('system'))).toBe('system');
  });
});

describe('resolveTheme', () => {
  it('honours an explicit choice regardless of the OS setting', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('follows the OS only when set to system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});
