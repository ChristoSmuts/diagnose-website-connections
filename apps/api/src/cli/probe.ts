/**
 * Run a diagnostic from the terminal, without the web UI.
 *
 * Useful when self-hosting: it verifies the probe engine works on this machine
 * and network before anything else is wired up, and gives a quick way to check
 * a site from a server that has no browser.
 *
 *   node src/cli/probe.ts example.com
 *   node src/cli/probe.ts https://example.com --json
 */
import { analyse, formatBytes, ms as duration } from '@dwc/diagnostics';
import { loadConfig } from '../config.ts';
import { loadDotEnv } from '../env.ts';
import { runServerProbe } from '../probes/run.ts';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const url = args.find((a) => !a.startsWith('--'));

if (url === undefined) {
  console.error('Usage: node src/cli/probe.ts <url> [--json]');
  process.exit(1);
}

// Same .env as the server, so the CLI and the app never disagree about config.
loadDotEnv();
const config = loadConfig();

const evidence = await runServerProbe(url, config, (phase, status, message) => {
  if (asJson || status === 'started') return;
  const mark = status === 'complete' ? '✓' : status === 'skipped' ? '–' : '✗';
  console.error(`  ${mark} ${phase.padEnd(11)} ${message}`);
});

const verdict = analyse({ server: evidence, additionalVantages: [], client: null });

if (asJson) {
  console.log(JSON.stringify({ evidence, verdict }, null, 2));
  process.exit(0);
}

/*
 * Wraps the engine's own formatter rather than repeating it. The local version
 * printed "73ms", which breaks the spaced-unit rule the whole report follows —
 * the same fault that reached the progress messages, and for the same reason:
 * copy tests only ever see strings the engine produced.
 */
const ms = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—' : duration(n);

console.log(`\n${'='.repeat(72)}`);
console.log(`  ${verdict.headline}`);
console.log(`${'='.repeat(72)}`);
console.log(
  `\n  ${verdict.culprit.toUpperCase()}   score ${String(verdict.score)}/100   confidence ${verdict.confidence}`,
);
console.log(`\n  ${verdict.plain}\n`);

/*
 * Measured vantages first, unmeasured ones gathered underneath — the same split
 * the report makes. A CLI run never has browser evidence, so two of the three are
 * always unmeasured here and listing them inline buried the one that mattered.
 */
const vantages = [
  verdict.vantages.server,
  verdict.vantages.userConnection,
  verdict.vantages.networkPath,
];
const measured = vantages.filter((v) => v.status !== 'unknown');
const unmeasured = measured.length === 0 ? [] : vantages.filter((v) => v.status === 'unknown');

for (const vantage of measured.length === 0 ? vantages : measured) {
  console.log(`  [${vantage.status.padEnd(8)}] ${vantage.label.padEnd(18)} ${vantage.summary}`);
}

if (unmeasured.length > 0) {
  console.log('\n  NOT MEASURED');
  for (const vantage of unmeasured) {
    console.log(`    ${vantage.label} — ${vantage.summary}`);
  }
}

console.log('\n  MEASUREMENTS');
console.log(
  `    DNS lookup     ${ms(evidence.dns.lookupMs.value)}  (${evidence.dns.consistent ? 'resolvers agree' : 'RESOLVERS DISAGREE'})`,
);
for (const address of evidence.addresses) {
  const state = address.reachable
    ? ms(address.tcpConnectMs.value)
    : `unreachable — ${address.error ?? 'no reason given'}`;
  console.log(`    TCP IPv${String(address.family)}       ${state}  ${address.address}`);
}
if (evidence.tls !== null) {
  console.log(
    `    TLS handshake  ${ms(evidence.tls.handshakeMs.value)}  ${evidence.tls.protocol ?? '?'} / ${evidence.tls.cipher ?? '?'} / alpn=${evidence.tls.alpn ?? 'none'}`,
  );
  if (evidence.tls.certificate !== null) {
    const cert = evidence.tls.certificate;
    console.log(
      `    Certificate    ${cert.issuer}, expires in ${String(Math.round(cert.daysUntilExpiry))} days, chain of ${String(cert.chainLength)}`,
    );
  }
}
if (evidence.http !== null) {
  console.log(
    `    TTFB           ${ms(evidence.http.ttfbMs.value)}  HTTP/${evidence.http.httpVersion}, status ${String(evidence.http.status)}`,
  );
  console.log(
    `    Transferred    ${evidence.http.transferredBytes.value === null ? '—' : formatBytes(evidence.http.transferredBytes.value)}  encoding=${evidence.http.contentEncoding ?? 'none'}`,
  );
}
if (evidence.stability !== null) {
  const s = evidence.stability.ttfb;
  console.log(
    `    Consistency    median ${ms(s.median)}  p95 ${ms(s.p95)}  jitter ${ms(s.jitter)}  (${String(s.count)} samples, ${String(s.failed)} failed)`,
  );
}
console.log(
  `    Hosted by      ${evidence.network.asnName ?? 'unknown'} ${evidence.network.asn ?? ''} ${evidence.network.cdnDetected !== null ? `— CDN: ${evidence.network.cdnDetected}` : ''}`,
);

console.log(`\n  FINDINGS (${String(verdict.findings.length)})`);
for (const finding of verdict.findings) {
  console.log(`\n    [${finding.severity}] ${finding.title}`);
  console.log(`      ${finding.plain}`);
  console.log(`      Who fixes it: ${finding.owner}`);
}
console.log();
