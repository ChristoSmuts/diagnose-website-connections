# Deploying an instance

For putting this somewhere other people can reach. If you only want to run it yourself, the
[README](README.md) quick start is all you need — a local install is a first-class deployment, not a
degraded one.

The whole app is one container: the API serves the built web app on the same origin, keeps its data in
one SQLite file, and needs no reverse proxy to function. What follows adds a domain, HTTPS and a
password, and explains the one decision that changes what the tool can measure.

## The decision that matters: where TLS ends

The browser measures its latency baseline against **this instance**. The route verdict subtracts that
baseline from the reader's time to the site they are diagnosing.

If a CDN or a tunnel sits in front, the reader's connection ends at a point of presence near them and
never reaches your machine. The baseline is then short by however far the target actually is, and the
leftover — which would be handed to the reader's internet provider — is really just distance.

The engine detects this and refuses rather than guessing, so nothing lies either way. But the two
deployments do not measure the same things:

| In front of the instance | Their server | Their connection | The route between |
| ------------------------ | ------------ | ---------------- | ----------------- |
| Nothing — TLS on the box | measured     | measured         | **measured**      |
| Cloudflare, a tunnel     | measured     | measured         | cannot be judged  |

A tunnel is genuinely easier and perfectly legitimate. It just costs you the third verdict. The setup
below terminates TLS on the machine, which is why it is the recommended one.

There is a second route to the same answer that works behind anything, including on a laptop — see
[Reference endpoints](#reference-endpoints) at the end.

## A machine

Anything that runs a container with a real disk. Oracle Cloud's Always Free Ampere instances are the
only genuinely free option with persistent storage: as of June 2026 the allocation is 2 OCPU and 12 GB,
halved from the previous 4/24, which is still several times what any free PaaS tier offers.

Two things to know before you commit:

- A card is required for identity verification, and Ampere capacity is often unavailable in popular
  regions. Your home region is fixed at signup.
- Idle instances are reclaimed. The hourly self-check below prevents that and smoke-tests the engine at
  the same time.

Render's free tier cannot host this: free web services get no persistent disk, so the database would be
erased on every restart, and their 0.1 CPU allocation would make the probe's own measurements unreliable.
Railway has no free tier — a 30-day trial, then $1/month of credit.

## Install

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2
sudo usermod -aG docker "$USER" && newgrp docker
```

Open 80 and 443. Oracle needs this in **both** places — the VCN security list in the console _and_ the
instance firewall — which is the single most common reason a fresh Oracle VM appears unreachable:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

## Configure

```bash
git clone https://github.com/ChristoSmuts/diagnose-website-connections.git
cd diagnose-website-connections
cp .env.example .env
```

In `.env`:

```bash
AUTH_MODE=password
AUTH_PASSWORD=<something long>

# Caddy is in front, so the client address arrives in a header. Without this
# every visitor shares one rate-limit bucket — all of them together get 20
# diagnostics a minute.
TRUST_PROXY=true

# Only needed if you serve the app from a different origin than the API. The
# single-container deployment does not.
# CORS_ORIGINS=https://diagnostics.example.com
```

`AUTH_MODE=password` is **one shared secret, not accounts**. Everyone who signs in shares one report
history. That is fine for a handful of testers and it is not privacy between them — see
[SECURITY.md](SECURITY.md).

## Run it

Use the published image rather than building on the VM. Create `docker-compose.override.yml`:

```yaml
services:
  diagnostics:
    build: !reset null
    image: ghcr.io/christosmuts/diagnose-website-connections:latest
    ports: !override
      - '127.0.0.1:8787:8787'
```

Binding to `127.0.0.1` is deliberate: Caddy is the only thing that should reach the app directly, and
without this the container would also be answering on port 8787 of the public address, unencrypted and
bypassing everything below.

```bash
docker compose up -d
docker compose logs -f      # "diagnostics engine ready" names the .env it loaded
```

## HTTPS

Point an A record at the VM's public IP, then:

```bash
sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```caddyfile
diagnostics.example.com {
	reverse_proxy 127.0.0.1:8787

	# Progress is streamed with server-sent events. Caddy does not buffer by
	# default, unlike nginx, so nothing else is needed here — but a diagnostic
	# legitimately takes up to 45 seconds and the default read timeout would
	# cut it off.
	transport http {
		read_timeout 120s
	}
}
```

```bash
sudo systemctl reload caddy
```

Caddy obtains and renews the certificate itself. Confirm the whole chain works, including that the app
knows it is behind a proxy rather than in front of a CDN:

```bash
curl -s https://diagnostics.example.com/api/health
# edgeTerminated must be false — if it is true, something is intercepting and
# the route verdict will correctly refuse to run.
```

## Keep it alive, and check it still works

Oracle reclaims instances that stay idle. An hourly self-diagnostic prevents that and tells you if the
engine has stopped being able to reach the internet:

```bash
crontab -e
```

```cron
17 * * * * cd /home/ubuntu/diagnose-website-connections && docker compose exec -T diagnostics node apps/api/src/cli/probe.ts example.com --json > /tmp/dwc-selfcheck.json 2>&1
```

## Backups

One file. Stop first — copying a live SQLite database can capture a torn write:

```bash
docker compose stop
cp data/dwc.db ~/dwc-$(date +%F).db
docker compose start
```

Reports are immutable and append-only, so the file only grows. There is no pruning job; for a testing
instance that will not matter for a long time.

## Updating

```bash
docker compose pull && docker compose up -d
```

Migrations run at boot. They are forward-only and additive, so an older database opens under a newer
image without intervention — but take a backup first anyway.

## Reference endpoints

The route verdict normally needs TLS terminating on the box. `REFERENCE_URLS` is a second way to get
one, and it works anywhere — behind a CDN, behind a tunnel, or on a laptop with no public address at
all.

The browser times a couple of well-known public endpoints alongside the target, over the same link, in
the same seconds. The quickest is roughly the reader's floor, so whatever the target costs above that
is what reaching _that particular site_ costs _them_. Nothing about your deployment enters into it.

```bash
REFERENCE_URLS=https://www.google.com/generate_204,https://cloudflare.com/cdn-cgi/trace
```

Empty by default, and nothing contacts a third party unless you set it. That is the same rule
`CONTROL_URL` follows, for the same reason: this tool otherwise talks to nobody but the site being
diagnosed.

## A note on acceptable use

This instance opens outbound connections to whatever address a visitor types. Every hosting provider's
terms include an anti-scanning clause written for a different activity, and abuse desks act on
complaints and volume rather than on traffic shape — one connection to one publicly-served web server
is what a browser does.

Two things keep you on the right side of it. The SSRF guard refuses private and link-local ranges,
including cloud metadata endpoints, which is the clause that would actually be invoked against you. And
the per-IP rate limit is only real if `TRUST_PROXY` is set, so do not skip it. Publishing a contact
address is worth it if the instance is public: providers mainly need to be able to answer a complaint.
