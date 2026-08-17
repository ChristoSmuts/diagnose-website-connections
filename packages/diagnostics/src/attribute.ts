import type { Confidence, Culprit, Evidence, VantageHealth } from '@dwc/contracts';

export interface Vantages {
  server: VantageHealth;
  userConnection: VantageHealth;
  networkPath: VantageHealth;
}

export interface Attribution {
  culprit: Culprit;
  confidence: Confidence;
  confidenceReason: string | null;
  score: number;
}

/** A vantage counts as problematic only when we actually measured a problem. */
const hasProblem = (v: VantageHealth): boolean => v.status === 'degraded' || v.status === 'bad';
const isUnknown = (v: VantageHealth): boolean => v.status === 'unknown';

/**
 * Decide whose fault it is.
 *
 * The table below is the entire thesis of the product: comparing a neutral
 * server-side view, the user's own link, and the path between them is what
 * turns "the site feels slow" into an answer somebody can act on.
 *
 * Two rules are enforced structurally rather than left to good intentions:
 *
 *  1. Without browser-side evidence we can NEVER blame the user's connection or
 *     the path. We have not measured either, and guessing would be the single
 *     most damaging thing this tool could do — it would send people to fight
 *     with their ISP over someone else's slow server.
 *
 *  2. When the evidence genuinely does not separate the cases, the answer is
 *     'inconclusive'. Admitting ignorance is a legitimate result.
 */
export function attribute(evidence: Evidence, vantages: Vantages): Attribution {
  const { server, userConnection, networkPath } = vantages;

  // Total failure short-circuits everything: there is no timing to compare.
  if (evidence.server.fatalError !== null || (server.status === 'bad' && server.score === 0)) {
    return {
      culprit: 'unreachable',
      confidence: 'high',
      confidenceReason: null,
      score: 0,
    };
  }

  if (isUnknown(server)) {
    return {
      culprit: 'inconclusive',
      confidence: 'low',
      confidenceReason: 'We could not measure the site’s response time.',
      score: overallScore(vantages),
    };
  }

  const serverProblem = hasProblem(server);
  const clientMeasured = !isUnknown(userConnection);
  const userProblem = clientMeasured && hasProblem(userConnection);
  const pathProblem = !isUnknown(networkPath) && hasProblem(networkPath);

  const score = overallScore(vantages);

  // Rule 1: no browser measurement means the user and the path are off the table.
  if (!clientMeasured) {
    return {
      culprit: serverProblem ? 'server' : 'healthy',
      confidence: 'medium',
      confidenceReason:
        'Measured only from our server. Run the test in your browser to check your own connection and the route to this site.',
      score,
    };
  }

  if (serverProblem && userProblem) {
    return {
      culprit: 'mixed',
      confidence: 'medium',
      confidenceReason: 'Two separate problems are overlapping, which makes each harder to size.',
      score,
    };
  }

  if (serverProblem) {
    return { culprit: 'server', confidence: 'high', confidenceReason: null, score };
  }

  if (userProblem) {
    return { culprit: 'user-connection', confidence: 'high', confidenceReason: null, score };
  }

  if (pathProblem) {
    return {
      culprit: 'network-path',
      // Always inferred rather than measured — we deduce the path from the two
      // endpoints rather than observing it, so this can never be 'high'.
      confidence: 'medium',
      confidenceReason:
        'The route is worked out by comparing both ends rather than measured directly.',
      score,
    };
  }

  return { culprit: 'healthy', confidence: 'high', confidenceReason: null, score };
}

/**
 * Overall 0–100 health.
 *
 * A weighted average, then held close to the worst component so a single severe
 * problem cannot be averaged into looking acceptable — an unusable site with
 * great DNS is still an unusable site, and a user experiences the worst link in
 * the chain rather than the average of them.
 */
export function overallScore(vantages: Vantages): number {
  const parts: { score: number; weight: number }[] = [];

  if (vantages.server.score !== null) parts.push({ score: vantages.server.score, weight: 0.5 });
  if (vantages.userConnection.score !== null)
    parts.push({ score: vantages.userConnection.score, weight: 0.3 });
  if (vantages.networkPath.score !== null)
    parts.push({ score: vantages.networkPath.score, weight: 0.2 });

  if (parts.length === 0) return 0;

  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  const weighted = parts.reduce((sum, p) => sum + p.score * p.weight, 0) / totalWeight;
  const worstPart = Math.min(...parts.map((p) => p.score));

  // Anchored to the worst vantage, pulled up only slightly by healthy ones.
  // A plain weighted average lets two perfect scores hide one broken component,
  // which is exactly backwards: a visitor experiences the weakest link, not the
  // mean of the chain.
  return Math.max(0, Math.min(100, Math.round(worstPart + (weighted - worstPart) * 0.3)));
}

/**
 * Reduce confidence when the underlying samples are too thin to support it.
 *
 * Applied after attribution so every code path benefits, including the ones
 * that would otherwise hand back a confident-sounding 'high'.
 */
export function temperConfidence(attribution: Attribution, evidence: Evidence): Attribution {
  const sampleCount = evidence.server.stability?.ttfb.count ?? 0;

  if (sampleCount > 0 && sampleCount < 3) {
    return {
      ...attribution,
      confidence: attribution.confidence === 'high' ? 'medium' : 'low',
      confidenceReason:
        attribution.confidenceReason ??
        `Based on only ${sampleCount} sample${sampleCount === 1 ? '' : 's'}, so timings may not be typical.`,
    };
  }

  return attribution;
}
