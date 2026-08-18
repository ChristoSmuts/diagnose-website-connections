import type { Evidence, Finding } from '@dwc/contracts';
import { detectClientFindings, detectPathFindings } from './client.js';
import { rankFindings } from './helpers.js';
import {
  detectConnectivityFindings,
  detectDnsFindings,
  detectHttpFindings,
  detectStabilityFindings,
  detectTlsFindings,
} from './server.js';

export * from './helpers.js';

/**
 * Run every detector and return the findings worst-first.
 *
 * Detectors are intentionally independent and side-effect free: each looks at
 * the evidence and decides in isolation. That keeps them individually testable
 * and means adding a new check never risks disturbing an existing one.
 */
export function detectFindings(evidence: Evidence, pathExcessMs: number | null): Finding[] {
  const { server, client } = evidence;

  // Nothing below reachability is meaningful if we never got a response, and
  // emitting a pile of secondary complaints about a site that is simply down
  // would bury the one fact that matters.
  if (server.fatalError !== null) {
    return rankFindings([...detectDnsFindings(server), ...detectConnectivityFindings(server)]);
  }

  return rankFindings([
    ...detectDnsFindings(server),
    ...detectConnectivityFindings(server),
    ...detectTlsFindings(server),
    ...detectHttpFindings(server),
    ...detectStabilityFindings(server),
    ...detectClientFindings(client),
    ...detectPathFindings(evidence, pathExcessMs),
  ]);
}
