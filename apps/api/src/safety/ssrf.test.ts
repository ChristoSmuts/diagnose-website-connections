import { describe, expect, it } from 'vitest';
import {
  BlockedTargetError,
  InvalidUrlError,
  assertAddressAllowed,
  describeBlockedAddress,
  normalizeUrl,
} from './ssrf.ts';

/**
 * These tests exist because this endpoint takes a URL from an untrusted user and
 * connects to it. Every case below is a real technique, not a hypothetical.
 */
describe('address denylist', () => {
  it('blocks the cloud metadata endpoint', () => {
    // The single highest-value SSRF target: returns credentials on most clouds.
    expect(describeBlockedAddress('169.254.169.254')).toMatch(/metadata/i);
    expect(describeBlockedAddress('100.100.100.200')).toMatch(/metadata/i);
  });

  it.each([
    ['127.0.0.1', /loopback/i],
    ['127.1.1.1', /loopback/i],
    ['10.0.0.5', /private/i],
    ['172.16.31.7', /private/i],
    ['172.20.0.1', /private/i],
    ['192.168.1.1', /private/i],
    ['169.254.10.10', /link-local/i],
    ['0.0.0.0', /this network/i],
    ['100.64.0.1', /carrier-grade/i],
    ['224.0.0.1', /multicast/i],
  ])('blocks %s', (address, expected) => {
    expect(describeBlockedAddress(address)).toMatch(expected);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '11.0.0.1'])(
    'allows the public address %s',
    (address) => {
      expect(describeBlockedAddress(address)).toBeNull();
    },
  );

  it('does not mistake addresses just outside a private range for private ones', () => {
    // 172.16.0.0/12 covers 172.16–172.31 only. Off-by-one here would either
    // block legitimate sites or, worse, allow real internal ones.
    expect(describeBlockedAddress('172.15.0.1')).toBeNull();
    expect(describeBlockedAddress('172.32.0.1')).toBeNull();
    expect(describeBlockedAddress('172.16.0.0')).toMatch(/private/i);
    expect(describeBlockedAddress('172.31.255.255')).toMatch(/private/i);
  });

  it('blocks IPv6 loopback and private ranges', () => {
    expect(describeBlockedAddress('::1')).toMatch(/loopback/i);
    expect(describeBlockedAddress('fd00::1')).toMatch(/private/i);
    expect(describeBlockedAddress('fc00::1')).toMatch(/private/i);
    expect(describeBlockedAddress('fe80::1')).toMatch(/link-local/i);
  });

  it('sees through IPv4-mapped IPv6, which would otherwise bypass every v4 rule', () => {
    expect(describeBlockedAddress('::ffff:127.0.0.1')).toMatch(/loopback/i);
    expect(describeBlockedAddress('::ffff:169.254.169.254')).toMatch(/metadata/i);
    expect(describeBlockedAddress('::ffff:10.0.0.1')).toMatch(/private/i);
  });

  it('allows public IPv6', () => {
    expect(describeBlockedAddress('2606:2800:220:1:248:1893:25c8:1946')).toBeNull();
  });

  it('throws a user-safe message rather than leaking internals', () => {
    expect(() => assertAddressAllowed('127.0.0.1')).toThrow(BlockedTargetError);
    expect(() => assertAddressAllowed('127.0.0.1')).toThrow(/only public websites/i);
  });
});

describe('URL normalisation', () => {
  it('accepts what a person would actually type', () => {
    expect(normalizeUrl('example.com').normalizedUrl).toBe('https://example.com/');
    expect(normalizeUrl('  example.com  ').host).toBe('example.com');
    expect(normalizeUrl('EXAMPLE.COM').host).toBe('example.com');
    expect(normalizeUrl('http://example.com').scheme).toBe('http');
  });

  it('defaults to https rather than http', () => {
    expect(normalizeUrl('example.com').scheme).toBe('https');
    expect(normalizeUrl('example.com').port).toBe(443);
  });

  it('keeps an explicit port', () => {
    expect(normalizeUrl('example.com:8443').port).toBe(8443);
  });

  it('strips credentials so they cannot end up in logs or reports', () => {
    const result = normalizeUrl('https://user:secret@example.com/path');
    expect(result.normalizedUrl).not.toContain('secret');
    expect(result.normalizedUrl).not.toContain('user');
  });

  it('strips the fragment, which is never sent to a server anyway', () => {
    expect(normalizeUrl('https://example.com/page#section').normalizedUrl).not.toContain('#');
  });

  it.each(['file:///etc/passwd', 'gopher://example.com', 'ftp://example.com', 'javascript:alert(1)'])(
    'rejects the non-http scheme %s',
    (input) => {
      expect(() => normalizeUrl(input)).toThrow(InvalidUrlError);
    },
  );

  it('rejects empty input with something a user can act on', () => {
    expect(() => normalizeUrl('   ')).toThrow(/enter a website address/i);
  });

  it('blocks a literal private IP typed directly', () => {
    expect(() => normalizeUrl('http://127.0.0.1:8080')).toThrow(BlockedTargetError);
    expect(() => normalizeUrl('http://169.254.169.254/latest/meta-data/')).toThrow(BlockedTargetError);
    expect(() => normalizeUrl('http://[::1]:3000')).toThrow(BlockedTargetError);
  });

  it('allows a public literal IP', () => {
    expect(normalizeUrl('http://93.184.216.34').host).toBe('93.184.216.34');
  });

  it('rejects an out-of-range port', () => {
    expect(() => normalizeUrl('example.com:99999')).toThrow(InvalidUrlError);
  });
});
