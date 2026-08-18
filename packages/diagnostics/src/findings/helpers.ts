import type { Confidence, Finding, FindingCode, Owner, Provenance, Severity } from '@dwc/contracts';
import { SEVERITY_ORDER } from '@dwc/contracts';

export interface FindingInput {
  code: FindingCode;
  severity: Severity;
  owner: Owner;
  confidence?: Confidence;
  title: string;
  plain: string;
  impact: string;
  technical: string;
  evidence?: { label: string; value: string; provenance?: Provenance }[];
  remediation?: {
    summary: string;
    steps: string[];
    snippet?: { language: string; code: string; caption?: string };
    expectedImprovement?: string;
  };
}

/** Builds a Finding with the verbose defaults filled in, so detectors stay readable. */
export function finding(input: FindingInput): Finding {
  return {
    code: input.code,
    severity: input.severity,
    owner: input.owner,
    confidence: input.confidence ?? 'high',
    title: input.title,
    plain: input.plain,
    impact: input.impact,
    technical: input.technical,
    evidence: (input.evidence ?? []).map((e) => ({
      label: e.label,
      value: e.value,
      provenance: e.provenance ?? 'measured',
    })),
    remediation: input.remediation
      ? {
          summary: input.remediation.summary,
          steps: input.remediation.steps,
          snippet: input.remediation.snippet ?? null,
          expectedImprovement: input.remediation.expectedImprovement ?? null,
        }
      : null,
  };
}

/**
 * Worst first, so the UI never has to decide what matters.
 *
 * Ties break on owner: things the reader can act on themselves come before
 * things only the site owner can change. Advice you can act on now is more
 * useful than advice you can only forward to someone else.
 */
export function rankFindings(findings: readonly Finding[]): Finding[] {
  const ownerRank: Record<Owner, number> = {
    you: 0,
    'site-owner': 1,
    'your-isp': 2,
    nobody: 3,
  };

  return findings.slice().sort((a, b) => {
    const bySeverity = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    if (bySeverity !== 0) return bySeverity;
    return ownerRank[a.owner] - ownerRank[b.owner];
  });
}

/** Human-friendly byte formatting for evidence rows. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Durations, with a space before the unit.
 *
 * "41 ms" rather than "41ms": the space is the typographic convention for a unit
 * and it reads as a measurement instead of an identifier. Also keeps the numeral
 * visually separate when set in tabular figures.
 */
export const ms = (n: number): string => `${String(Math.round(n))} ms`;

/**
 * Pluralises a counted noun properly.
 *
 * Replaces "4 address(es)" and "0 hop(s)". Parenthesised plurals are the sort of
 * thing that reads as a placeholder nobody came back to, and the report is meant
 * to be forwarded to a hosting provider or client.
 */
export const plural = (count: number, singular: string, pluralForm?: string): string =>
  `${String(count)} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
