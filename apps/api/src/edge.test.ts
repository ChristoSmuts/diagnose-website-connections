import { describe, expect, it } from 'vitest';
import { detectEdge, edgeHeader } from './edge.ts';

describe('detecting our own CDN edge', () => {
  it.each([
    ['cf-ray', 'a2d1207049284193-CPT'],
    ['cf-connecting-ip', '203.0.113.7'],
    ['true-client-ip', '203.0.113.7'],
    ['x-amz-cf-id', 'abc123=='],
    ['x-vercel-id', 'cpt1::abcde-1700000000000'],
    ['fly-client-ip', '203.0.113.7'],
  ])('recognises %s', (name, value) => {
    expect(detectEdge({ [name]: value })).toBe(true);
    expect(edgeHeader({ [name]: value })).toBe(name);
  });

  /**
   * The case the whole allowlist exists to get right.
   *
   * Caddy on the same machine sets x-forwarded-for while TLS still terminates
   * here, so the baseline is sound. Treating any proxy header as an edge would
   * disable the route verdict for exactly the deployment that makes the route
   * measurable.
   */
  it('does not treat a same-host reverse proxy as an edge', () => {
    expect(detectEdge({ 'x-forwarded-for': '203.0.113.7' })).toBe(false);
    expect(detectEdge({ 'x-forwarded-proto': 'https', 'x-real-ip': '203.0.113.7' })).toBe(false);
    expect(detectEdge({ forwarded: 'for=203.0.113.7;proto=https' })).toBe(false);
  });

  it('finds nothing in a direct request', () => {
    expect(detectEdge({ host: 'example.com', 'user-agent': 'x' })).toBe(false);
    expect(edgeHeader({})).toBeNull();
  });

  it('ignores an empty header value', () => {
    expect(detectEdge({ 'cf-ray': '' })).toBe(false);
    expect(detectEdge({ 'cf-ray': [] })).toBe(false);
  });

  it('accepts a repeated header', () => {
    expect(detectEdge({ 'cf-ray': ['a-CPT', 'b-JNB'] })).toBe(true);
  });
});
