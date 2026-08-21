import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

/**
 * `CONTROL_URL` is the one setting that decides whether the report may say
 * anything at all about the reader's own connection, so what it does with the
 * value it is given is worth pinning down.
 */
describe('CONTROL_URL', () => {
  /**
   * The regression that motivated all of this.
   *
   * The value used to be reduced to `parsed.origin`, on the reasoning that the
   * browser appends `/api/ping` to it. That is true only when the endpoint turns
   * out to be another instance of this app; anything else is fetched exactly as
   * configured. So the documented `https://www.google.com/generate_204` became a
   * request for the Google home page, twelve times, and the weight of that page
   * was reported as the reader's latency: 957 ms measured on a Cape Town fibre
   * line that pings in 11 ms, against 30 ms for the same endpoint with its path
   * intact. The report called the connection slow, which was a lie about someone's
   * internet provider.
   */
  it('keeps the path, because an unpaired endpoint is fetched exactly as given', () => {
    const config = loadConfig({ CONTROL_URL: 'https://www.google.com/generate_204' });
    expect(config.controlUrl).toBe('https://www.google.com/generate_204');
  });

  it('keeps a query string too', () => {
    const config = loadConfig({ CONTROL_URL: 'https://speed.example.net/__down?bytes=0' });
    expect(config.controlUrl).toBe('https://speed.example.net/__down?bytes=0');
  });

  it('leaves a bare origin alone rather than inventing a path for it', () => {
    const config = loadConfig({ CONTROL_URL: 'https://control.example.net' });
    expect(config.controlUrl).toBe('https://control.example.net/');
  });

  it('is null when unset, which means same-origin', () => {
    expect(loadConfig({}).controlUrl).toBeNull();
    expect(loadConfig({ CONTROL_URL: '   ' }).controlUrl).toBeNull();
  });

  /**
   * An endpoint the browser cannot reach across the internet measures the machine
   * or the LAN, not the connection. The verdict layer already refuses to judge a
   * loopback control, but silently and much later — and the docs promised outright
   * refusal long before the code did it.
   *
   * 203.0.113.7 is in here rather than in the allowed list because it is RFC 5737
   * documentation space, which the SSRF denylist already blocks. Reusing that
   * denylist means this stays in step with it for free.
   */
  it.each([
    'http://localhost:8787',
    'http://LOCALHOST:8787/generate_204',
    'http://127.0.0.1:8787',
    'http://192.168.1.10:8787',
    'http://10.0.0.5',
    'http://[::1]:8787',
    'http://dev.local',
    'http://box.localhost',
    'http://203.0.113.7:8787',
  ])('refuses %s at boot', (url) => {
    expect(() => loadConfig({ CONTROL_URL: url })).toThrow(/not one|public address/i);
  });

  it('names the offending host so the message is actionable', () => {
    expect(() => loadConfig({ CONTROL_URL: 'http://127.0.0.1:8787' })).toThrow(/127\.0\.0\.1/);
  });

  it('still rejects a non-absolute or non-http value', () => {
    expect(() => loadConfig({ CONTROL_URL: 'example.com' })).toThrow(/absolute URL/i);
    expect(() => loadConfig({ CONTROL_URL: 'ftp://example.com' })).toThrow(/http or https/i);
  });

  /**
   * A public address that merely looks unusual is not local. Refusing too much
   * would take the feature away from anyone hosting on a plain IP.
   */
  it.each(['https://control.example.net/ping', 'http://8.8.8.8', 'https://1.1.1.1/ping'])(
    'allows %s',
    (url) => {
      expect(() => loadConfig({ CONTROL_URL: url })).not.toThrow();
    },
  );
});
