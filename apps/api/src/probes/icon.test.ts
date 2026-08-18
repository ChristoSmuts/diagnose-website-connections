import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { toDataUrl } from './icon.ts';

/**
 * The favicon comes from the site being diagnosed, which is untrusted input by
 * definition — the whole service exists because a stranger handed us that URL.
 * These bytes end up in a data URL rendered by the reader's browser, so what the
 * origin is allowed to say about them is the part worth pinning down.
 */

const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe('wrapping a fetched icon in a data URL', () => {
  it.each([
    'image/png',
    'image/x-icon',
    'image/vnd.microsoft.icon',
    'image/gif',
    'image/jpeg',
    'image/webp',
  ])('accepts %s', (type) => {
    expect(toDataUrl(type, BYTES)).toBe(`data:${type};base64,${BYTES.toString('base64')}`);
  });

  it('tolerates a charset parameter and odd casing', () => {
    expect(toDataUrl('IMAGE/PNG; charset=binary', BYTES)).toBe(
      `data:image/png;base64,${BYTES.toString('base64')}`,
    );
  });

  /**
   * SVG is a document format that can carry script. A favicon is not worth
   * accepting one from an arbitrary origin, however convenient.
   */
  it('refuses SVG', () => {
    expect(toDataUrl('image/svg+xml', BYTES)).toBeNull();
  });

  it('refuses anything that is not an image', () => {
    for (const type of ['text/html', 'application/javascript', 'text/plain', '']) {
      expect(toDataUrl(type, BYTES), type).toBeNull();
    }
  });

  /**
   * The type is looked up, never echoed. Without the allowlist the site chooses
   * what the browser renders the bytes as, which is the actual hazard here.
   */
  it('never echoes a type it was not expecting', () => {
    const hostile = toDataUrl('text/html;charset=utf-8', Buffer.from('<script>x</script>'));
    expect(hostile).toBeNull();
  });

  it('refuses an empty body, which would render as a broken image', () => {
    expect(toDataUrl('image/png', Buffer.alloc(0))).toBeNull();
  });
});
