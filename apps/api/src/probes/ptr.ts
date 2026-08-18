import { Resolver } from 'node:dns/promises';

/**
 * Reverse DNS for an address.
 *
 * Worth asking for because hosting providers name these after the facility the
 * machine sits in — `ams`, `fra1`, `af-south-1`, `iad` — which is frequently the
 * only public statement anyone makes about where a server physically is. It is a
 * naming convention rather than a record of location, and nothing downstream may
 * treat it as more than a hint.
 *
 * Uses the same configured resolvers as every other lookup here, for the same
 * reason: a measurement must not become a property of whichever resolver the
 * host happens to have.
 */
export async function probePtr(
  address: string,
  resolvers: readonly string[],
  timeoutMs = 4000,
): Promise<string | null> {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  resolver.setServers([...resolvers]);

  try {
    const names = await resolver.reverse(address);
    const first = names[0];
    return first !== undefined && first.length > 0 ? first : null;
  } catch {
    // Most addresses have no PTR at all, and a resolver may simply refuse the
    // zone. Enrichment must never fail the diagnostic — same rule as the ASN
    // lookup next door.
    return null;
  }
}
