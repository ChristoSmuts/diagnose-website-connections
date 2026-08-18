import type { Culprit, Evidence, Finding } from '@dwc/contracts';
import { ms } from './findings/helpers.js';
import { LOCAL_CONTROL_RTT_MS, THRESHOLDS } from './thresholds.js';

/**
 * Layer 1 copy: the sentence most people will read and then stop.
 *
 * Rules this text obeys, deliberately:
 *  - No unexplained jargon. Not one term.
 *  - Name who owns the problem, because that is the actual question.
 *  - Say what is NOT wrong too. "It isn't your internet" is genuinely useful
 *    information and stops people troubleshooting the wrong thing for an hour.
 *  - Numbers appear in the elaboration, never the headline.
 */
export function narrate(
  culprit: Culprit,
  evidence: Evidence,
  findings: readonly Finding[],
): { headline: string; plain: string } {
  const host = evidence.server.target.host;
  const ttfb = evidence.server.http?.ttfbMs.value ?? null;
  const worst = findings[0];

  /**
   * A loopback round trip is not a statement about anyone's internet.
   *
   * The vantage tiles already report "not measured" in this case; the prose must
   * agree, or the report contradicts itself — saying "your connection looks
   * healthy at 3ms" directly beside a tile reading "Not measured".
   */
  const rawRtt = evidence.client?.control.median ?? null;
  const rtt = rawRtt !== null && rawRtt >= LOCAL_CONTROL_RTT_MS ? rawRtt : null;

  switch (culprit) {
    case 'healthy': {
      /*
       * The headline must not claim "nothing is holding it back" while the very
       * next line lists things worth improving — which is what it did, next to a
       * checks summary reading "5 worth attention". Nothing here is *wrong*, but
       * a healthy site with suggestions is a different sentence from a healthy
       * site with none, so it gets one.
       */
      const hasSuggestions = findings.length > 0;

      return {
        headline: hasSuggestions
          ? `${host} is healthy. A few things could be better, but nothing is wrong.`
          : `${host} is responding well, and nothing is holding it back.`,
        plain: join([
          ttfb !== null
            ? `It sent its first byte in ${ms(ttfb)}, which is comfortably quick.`
            : 'The site responded normally to every check we ran.',
          rtt !== null ? `Your own connection is healthy too, at ${ms(rtt)} round trip.` : '',
          hasSuggestions
            ? 'The suggestions below are worth knowing about, but none of them need acting on.'
            : 'We found nothing that needs fixing.',
        ]),
      };
    }

    case 'server': {
      // "Slow" and "erratic" are different problems with different fixes, and a
      // site that answers in 60ms must never be called slow just because one
      // sample was unlucky.
      const erratic = ttfb !== null && ttfb <= THRESHOLDS.ttfbMs.ok;
      const stats = evidence.server.stability?.ttfb;

      if (erratic) {
        return {
          headline: `${host} responds unevenly — the problem is on their end, not your internet connection.`,
          plain: join([
            stats !== undefined && stats.median !== null && stats.max !== null
              ? `Most requests came back in about ${ms(stats.median)}, but some took as long as ${ms(stats.max)}.`
              : 'The site answered quickly most of the time, but not consistently.',
            'We saw this from our own server on a fast connection, so it is the site being inconsistent rather than anything to do with your network.',
            'In practice this means the site feels fine most of the time and occasionally stalls, seemingly at random.',
          ]),
        };
      }

      return {
        headline: `${host} is slow to respond — the problem is on their end, not your internet connection.`,
        plain: join([
          ttfb !== null
            ? `The site took ${ms(ttfb)} to send its first byte, measured from our own server on a fast connection.`
            : 'The site was slow to respond even when measured from our own server on a fast connection.',
          'Because we saw the same slowness from a completely different network, everyone visiting this site is affected — not just you.',
          rtt !== null ? 'Your connection tested fine.' : '',
          worst ? `The biggest single factor: ${lowerFirst(worst.title)}` : '',
        ]),
      };
    }

    case 'user-connection':
      return {
        headline: `Your internet connection is what's slowing this down, not ${host}.`,
        plain: join([
          rtt !== null
            ? `Your connection took ${ms(rtt)} to reach our test server, which is slower than it should be.`
            : 'Your connection was slow or unsteady when reaching our test server.',
          `We measured ${host} separately from our own server and it responded normally, so the site itself is healthy.`,
          'A wired connection is the quickest way to tell whether the problem is Wi-Fi or the line itself.',
        ]),
      };

    case 'network-path':
      return {
        headline: `${host} and your connection are both fine on their own, but traffic between you is taking a slow route.`,
        plain: join([
          'We measured the site from our own server and it was quick. We measured your connection and it was healthy.',
          'Despite that, reaching this site from your device is slower than those two facts can explain — which points at the route your traffic takes, rather than either end.',
          'Either your provider is routing this traffic a long way round, or the site has no server near you. You cannot fix either directly, though a VPN sometimes changes the route enough to help.',
        ]),
      };

    case 'mixed':
      return {
        headline: `Two things are going wrong at once: ${host} is slow, and your connection is struggling too.`,
        plain: join([
          ttfb !== null
            ? `The site took ${ms(ttfb)} to respond even from our fast connection, so part of this is genuinely their end.`
            : 'The site was slow even from our own fast connection, so part of this is genuinely their end.',
          rtt !== null
            ? `Your own connection also tested slower than it should be, at ${ms(rtt)}.`
            : 'Your own connection also tested slower than it should be.',
          'Fixing your connection will help, but it will not make this site fast on its own.',
        ]),
      };

    case 'unreachable':
      return {
        headline: `We couldn't reach ${host} at all.`,
        plain: join([
          describeUnreachable(evidence),
          'This usually means the site is down, the address is wrong, or something is blocking the connection.',
        ]),
      };

    case 'inconclusive':
      return {
        headline: `We couldn't gather enough to say what's going on with ${host}.`,
        plain: join([
          'Some checks did not complete, so drawing a conclusion would mean guessing.',
          'Running the test again often resolves this, especially if the site was briefly busy.',
        ]),
      };

    default: {
      const exhaustive: never = culprit;
      throw new Error(`Unhandled culprit: ${String(exhaustive)}`);
    }
  }
}

function describeUnreachable(evidence: Evidence): string {
  const { server } = evidence;
  if (server.dns.records.length === 0) {
    return 'The address could not be looked up at all, which means this domain may not exist or its DNS is broken.';
  }
  if (server.addresses.length > 0 && !server.addresses.some((a) => a.reachable)) {
    return 'We found the site’s address, but every attempt to connect was refused or timed out.';
  }
  // Technical error strings arrive without terminal punctuation, which ran them
  // straight into the following sentence.
  return endSentence(
    server.fatalError ?? 'The connection failed before we could measure anything.',
  );
}

const endSentence = (text: string): string =>
  /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;

const join = (parts: readonly string[]): string =>
  parts
    .filter((p) => p.length > 0)
    .map(endSentence)
    .join(' ');

const lowerFirst = (s: string): string => (s.length === 0 ? s : s[0]!.toLowerCase() + s.slice(1));
