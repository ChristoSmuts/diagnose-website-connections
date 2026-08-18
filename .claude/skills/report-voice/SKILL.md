---
name: report-voice
description: |
  Write or review any user-facing copy in this diagnostics app — verdict headlines,
  finding titles, check descriptions, remediation steps, glossary entries, empty
  states, error messages. Enforces the register (readable, not dumbed down) and the
  honesty invariants that stop the report claiming things it did not measure.
  Use alongside the humanizer skill, not instead of it.
---

# Report voice

This app answers one question: **is it their server, your connection, or the path between?** Every
string exists to make that answer trustworthy and actionable.

Run [`humanizer`](../humanizer/SKILL.md) first for general prose problems. It knows nothing about this
product's constraints, which is what the rest of this document covers.

## Register: readable, not dumbed down

Write for a competent adult who is not a network engineer. A developer, an IT-adjacent manager, a
technically curious site owner.

- **Do** use short sentences, concrete nouns and real numbers.
- **Do** name a technical thing when it is the accurate word — then define it in the glossary so it
  becomes a tooltip.
- **Don't** explain what a website or the internet is.
- **Don't** pad with reassurance. "Don't worry, this is quite common!" wastes the most valuable line
  on the page.
- **Don't** spell out units in prose where the numeral is clearer. `668 ms` beats "668 milliseconds"
  once, and definitely beats it four times in a paragraph.

The earlier copy erred toward the layman end. Correcting that means trusting the reader more, not
adding jargon.

## The honesty invariants

These are the reason this skill exists separately. They are not style preferences — breaking one makes
the report lie, and this tool's only real asset is being trustworthy about attribution.

### 1. Never state a number for something that was not measured

Every metric carries `provenance` (`measured` | `inferred` | `unavailable`) and every vantage carries a
`status` that can be `unknown`. If it is `unknown`, the prose says so. It does not fill the gap.

This shipped as a real bug twice:

> ❌ "Your own connection also looks healthy, at 3 ms round trip."
> — printed directly beside a tile reading **Not measured**, because the control endpoint was on
> loopback. A 3 ms loopback round trip says nothing whatsoever about anyone's internet.

> ✅ "We could not measure your connection from here, so this verdict is about the site only."

### 2. Prose must never contradict the component beside it

Layer 1 sits next to tiles, a score dial and badges rendered from the same verdict. Read them together.

> ❌ "info.cern.ch is slow to respond (63 ms)" — beside a health score of **96**.
> The variance calculation had flipped the status on three samples of noise, and the narration reached
> for the "slow" template.

> ✅ "info.cern.ch answers quickly but unevenly — most requests in about 63 ms, some as slow as 400 ms."

### 3. Slow and erratic are different problems

They have different causes, different owners and different fixes. A site answering in 60 ms is never
"slow", however unlucky one sample was. Say _uneven_, _inconsistent_, or _stalls occasionally_.

### 4. Name who can fix it

Every finding and every remediation step states its owner. "Enable Brotli compression" is useless
advice to a visitor who does not run the server — and actively annoying, because it implies they
should be doing something.

- site owner → imperative, specific, with the actual config.
- the reader → only genuinely actionable steps.
- their ISP / nobody → say so plainly. "Nothing you can do about this directly" is a real, useful
  answer that saves someone an hour.

### 5. "Inconclusive" is a respectable verdict

Admitting ignorance beats inventing a culprit. Never hedge into vagueness that _reads_ like a
conclusion. If confidence is not high, the reason is shown.

### 6. Attribute to the vantage that justifies it

Only claim "everyone is affected" when the server vantage measured it. Only blame the reader's
connection when the client vantage measured it. The phrase "measured from our own server on a fast
connection" is doing real work — it is the evidence for the claim, not filler.

## Layer discipline

| Layer                      | Contains                                 | Rule                                                                                                                         |
| -------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **1 — verdict**            | `headline`, `plain`                      | The whole answer for most readers. Numbers go in `plain`, never the headline. No term that is not in the glossary.           |
| **2 — findings**           | `title`, `plain`, `impact`               | Ordinary words. `impact` is concrete: what a real visitor experiences.                                                       |
| **3 — technical + checks** | `technical`, `evidence[]`, `remediation` | Go as deep as the evidence allows. Real header names, cipher suites, cert fields, TTLs. This is where an engineer is served. |

**A term may not appear in Layer 1 or 2 unless it has a glossary entry.** A test enforces this.

Layer 3 has the opposite instruction from Layer 1: **do not simplify it.** Someone expanding a check
wants the raw truth, not another paraphrase. Name the RFC, quote the header, give the exact number.

## Checks vs findings

- A **finding** is something wrong. Ranked worst-first.
- A **check** is something we looked at, whether or not it passed.

A check that passed still deserves a real technical description — a healthy site should reward
inspection, not present an empty page. Write pass-state copy as informative, not congratulatory:
"TLS 1.3 with X25519 key exchange" not "Great! Your TLS is perfect! ✓"

`skipped` and `unavailable` are different facts and must read differently:

- `skipped` — "Not run: IPv6 checks need an IPv6 route from this host."
- `unavailable` — "Ran, but the server closed the connection before we could tell."

## Banned phrasings

- "Optimize your website for better performance" — vague, and not our claim to make.
- "It looks like there might possibly be an issue" — either there is or there is not.
- "Unfortunately", "Sadly", "Oops" — the reader wants an answer, not sympathy.
- "Simply", "just", "easily" before any instruction — it is not simple if they are reading this.
- "blazing fast", "lightning quick", "supercharge" — marketing register.
- Emoji in report copy. Status is carried by icon + word + colour, which is deliberate: colour alone
  must never carry meaning.
- Exclamation marks.
- Forced triads. "Restarting your router, moving closer to Wi-Fi, or trying a wired connection" reads
  as filler; give the one step most likely to help, or a real list of more than three.

## Worked recalibrations

The original copy is not bad — it is aimed slightly too low and reads slightly padded.

> **Before:** "The site started sending its page in 668 milliseconds, which is comfortably quick."
> **After:** "The site sent its first byte in 668 ms — comfortably quick."

> **Before:** "Restarting your router, moving closer to Wi-Fi, or trying a wired connection are the
> usual first steps."
> **After:** "A wired connection is the quickest way to confirm it is the Wi-Fi rather than the line."

> **Before:** "This usually means your provider is routing traffic a long way round, or the site's
> nearest server is far from you. Neither is something you can fix directly, though a VPN sometimes
> changes the route enough to help."
> **After:** "Either your provider routes this traffic a long way round, or the site has no server
> near you. You cannot fix either directly — a VPN sometimes changes the route enough to help."

## Before committing copy

1. Read Layer 1 aloud. Does it answer "whose fault is it?" in one sentence?
2. Check every number against its `provenance`. Is anything asserted that was not measured?
3. Read Layer 1 beside the tiles and score it renders with. Do they agree?
4. Does every finding name an owner?
5. Does every Layer 1/2 term have a glossary entry?
6. Would an engineer expanding a check learn something they could act on?
