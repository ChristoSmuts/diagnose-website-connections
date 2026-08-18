import type { Evidence, Verdict } from '@dwc/contracts';
import { attribute, temperConfidence, type Vantages } from './attribute.js';
import { buildChecks } from './checks.js';
import { detectFindings } from './findings/index.js';
import { buildGlossary } from './glossary.js';
import { narrate } from './narrate.js';
import { assessNetworkPath, assessServer, assessUserConnection } from './vantages.js';

/**
 * Stamped onto every verdict and stored with it.
 *
 * Thresholds and wording will be tuned over time. Recording which version
 * produced a conclusion is what stops an old stored report from being
 * reinterpreted under rules that did not exist when it was taken.
 */
export const ENGINE_VERSION = '1.1.0';

/**
 * Turn evidence into a verdict.
 *
 * Deliberately pure: no clock, no network, no randomness. The same evidence
 * always produces the same verdict, which is what makes the attribution logic
 * testable against fixtures rather than against the live internet.
 */
export function analyse(evidence: Evidence): Verdict {
  const server = assessServer(evidence.server);
  const userConnection = assessUserConnection(evidence.client);
  const path = assessNetworkPath(evidence);

  const vantages: Vantages = {
    server,
    userConnection,
    networkPath: {
      status: path.status,
      label: path.label,
      summary: path.summary,
      score: path.score,
    },
  };

  const findings = detectFindings(evidence, path.excessMs);
  const attribution = temperConfidence(attribute(evidence, vantages), evidence);
  const { headline, plain } = narrate(attribution.culprit, evidence, findings);

  return {
    culprit: attribution.culprit,
    headline,
    plain,
    score: attribution.score,
    confidence: attribution.confidence,
    confidenceReason: attribution.confidenceReason,
    vantages,
    findings,
    checks: buildChecks(evidence, findings),
    glossary: buildGlossary(findings),
    engineVersion: ENGINE_VERSION,
  };
}
