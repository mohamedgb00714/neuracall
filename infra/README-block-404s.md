# Blocking web scanners at the autoplans.dev reverse proxy

Goal: stop vulnerability-scanner and credential-harvest 404 noise (963
events / 7d in error telemetry, 0 real bugs among them) from ever reaching
the app, so it stops creating `NotFound` error groups. The block happens in
**nginx**, before `proxy_pass`, returning `410 Gone` for scanner paths and
`403 Forbidden` for known scanner User-Agents.

## Why nginx and why these status codes

- The vhost `/etc/nginx/sites-enabled/autoplans.dev` is a plain `:80`
  `default_server` reverse proxy to `127.0.0.1:3000`. Blocking there keeps
  the app uninvolved, so probes produce nginx answers instead of app 404s.
- `return 410 Gone` is preferred over `return 444` (skill guidance): 444
  drops the TCP connection, and behind Cloudflare that surfaces as a
  mystery 520 to the visitor; a real status is answered in one round trip,
  tells the scanner nothing, and is easy to assert with curl. `403` is used
  only for the optional User-Agent layer.
- `default_server` is kept, so raw-IP / unknown-Host probes (the bulk of
  the sweep) hit the same rules.

## Design decisions

- **Pattern, not enumeration.** Archive/database dumps are matched
  extension-based at any depth (`.zip`, `.tar`, `.tar.gz`, `.sql`, `.sql.gz`,
  `.sqlite`, `.bak`, `.old`, `.backup`, `/db*`, `/database*`, `/backup*`) so
  future probe names like `/2027.zip` are covered without editing config.
- **Anchored and extension-shaped for the generic words.** `settings`, `config`
  and `env` are real route words, so only the dump-shaped forms are blocked
  (`settings.json`, `/config/leaf.js`, `/env.prod`, `.env`) - never bare
  `/settings` or `/config`. Real in-use routes stay alive:
  `/api/csp-report`, `/api/*`, `/docs`, `/_next/*`, `/assets/`, `/.well-known/`.
- **Fake namespaces blocked by prefix.** Next.js serves nothing under
  `/wp*`, `/livewire`, `/graphql`, `/swagger`, `/owa`, `/ecp`, `/telescope`,
  `.git`, `/v2/_catalog`, so prefix rules are safe there. `/api` and
  `/server` (bare, no slash + nothing) are blocked exact-path only, to
  protect the real `/api/csp-report` endpoint.
- **Encoded variants handled by nginx normalization semantics.** The map
  keys on `$uri`, which nginx has already decoded (except `%2F`), so
  `/configs%2ejson` -> `/configs.json` and dies on the plain rule. What
  nginx does *not* decode - `%2f` encoded slashes and double-encoded dots
  (`%252e` -> `%2e`) - gets explicit residual-encoding rules at the bottom
  of the map.
- **User-Agent layer is deliberately narrow.** Only unambiguous tool names
  (sqlmap, nikto, nuclei, wpscan, masscan, zgrab, nessus, acunetix,
  netsparker, nmap, metasploit, ...). Generic UAs (curl, Go-http-client,
  python-requests, SEO bots) are never blocked on UA alone - they front too
  many legitimate checks. The path rules already stop 95%+ of the noise.
- **Only two edge-return directives in `location /`.** nginx's "if is evil"
  caveat applies to rewrite juggling, not to `return`; `if ($var) { return X; }`
  is the documented safe usage.
- **Logging untouched.** Blocks still write to the normal access log (no
  `error_page` indirection, no `access_log off`), so they remain visible for
  debugging and for a future fail2ban source.

## Apply (requires your sudo password - not automatable from the agent)

```bash
cd /home/msaid/Videos/neuracall

# 1. Patched vhost (drop-in replacement, includes the original for rollback)
sudo cp infra/nginx-autoplans.dev.conf.patch /etc/nginx/sites-enabled/autoplans.dev

# 2. The block maps - MUST be installed too, else `nginx -t` fails with
#    "unknown 'blocked' variable" (that is intentional; see vhost header).
sudo cp infra/nginx-block-404-noise.conf /etc/nginx/sites-enabled/nginx-block-404-noise.conf

# 3. Only reload if the syntax test passes
sudo nginx -t && sudo systemctl reload nginx
```

## Verify

Before (with nginx as the `:80` listener - i.e. once the fix is in place, undo
it temporarily, or compare against the app directly on `127.0.0.1:3000`): all
of these reach the app and log a 404 / land in telemetry.

```bash
for p in /wp/v2/users /livewire/update /configs.json /env.prod /2026.zip \
         /db.sqlite /api /tasting /configs%2ejson /configs%252ejson; do
  printf '%-22s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1$p)"
done
```

After - nginx answers itself, nothing proxies (expect 410, or 403 with a
scanner UA):

```bash
for p in /wp/v2/users /livewire/update /configs.json /env.prod /2026.zip \
         /db.sqlite /api /tasting /configs%2ejson /configs%252ejson; do
  printf '%-22s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1$p)"
done

# same through the public edge (Cloudflare -> origin) once deployed:
for p in / /wp/v2/users /configs.json /livewire/update; do
  printf '%-18s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' https://autoplans.dev$p)"
done
```

Legit routes must still proxy (expect 200/3xx from the app, or the app's own
4xx/5xx - never a 410/403 from nginx):

```bash
for p in / /docs /pricing /api/csp-report /api/v1/health \
         /.well-known/acme-challenge/ok /_next/static/chunks/x.js; do
  printf '%-34s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1$p)"
done
```

Scanner UA check (expect 403; a normal browser/curl UA stays unaffected):

```bash
curl -s -o /dev/null -w 'sqlmap UA -> %{http_code}\n' \
  -A 'sqlmap/1.7.0#stable' http://127.0.0.1/
curl -s -o /dev/null -w 'curl    UA -> %{http_code}\n' http://127.0.0.1/
```

Telemetry: after reload, new scanner hits stop creating `NotFound` error
groups over the following 24h. The ~26 pre-existing unresolved
`auto::NotFound` groups can then be resolved/ignored as noise.

## Rollback

```bash
sudo cp /etc/nginx/sites-enabled/autoplans.dev /etc/nginx/sites-enabled/autoplans.dev.blocked.bak
sudo rm   /etc/nginx/sites-enabled/nginx-block-404-noise.conf
# restore the vhost (either the .bak you just made, or hand-edit:
#   remove the two `if (...) { return ...; }` lines)
sudo nginx -t && sudo systemctl reload nginx
```

## Known realities on this box (verified at write time)

- **nginx is NOT currently running here.** The binary is not installed
  (`nginx: command not found`, no `nginx.service`); the complete
  `/etc/nginx/` tree exists but `:80` is owned by Apache2 (active), and the
  app on `127.0.0.1:3000` answers 404 to every probe observed (including `/`
  and `/api/csp-report`), so live "legit route still proxies" behaviour could
  not be confirmed against a running nginx from this session.
  Applying these files is only meaningful once nginx actually listens on `:80`
  (install it and free the port from Apache) - or if this box is not the live
  origin, on the real origin host.
- **No sudo access from the agent**: `sudo -n` fails (interactive auth
  required), so `nginx -t`, the `/etc/nginx` copies, and the reload are YOUR
  steps above. Nothing has been modified under `/etc` by this task.
- Configurally, the vhost and map files were checked here with a structural
  parser (brace/paren balance, every regex key compiled, block/pass corpus
  simulated for all observed probe paths and a set of legit paths) - NOT with
  a real `nginx -t`, which requires the nginx binary + root. Run the real
  `sudo nginx -t` before relying on it.
- Cloudflare fronts `autoplans.dev`. Out of scope here, but complementary
  Cloudflare-side rules (block known-404, managed malicious-activity rules)
  would stop the noise even further upstream.
## CORRECTION (verified 06 Sep 2026, apply-blocker)

On THIS host the nginx story is stale: `nginx` is NOT installed and is
inactive; `/etc/nginx/sites-enabled/{autoplans.dev,odoo}` are leftovers.
`:80` is owned by Apache2 (active), serving `/var/www/html` (static default
vhost; other local vhosts: odoo.local, roomix, wordpress.local — none proxy
to :3000). A local Node app listens on `:3000` but 404s every request
(dev instance), so the PRODUCTION autoplans.dev is NOT served from this box.

Consequence: applying these nginx rules here clears nothing — scanner
probes on this host are absorbed by Apache2's static 404 anyway, and the
telemetry noise ('autoplans.dev' error groups, 963 events/7d) originates
from wherever production autoplans.dev actually runs (Cloudflare edge?
another origin?). The rules below are correct as nginx drop-ins for that
origin's real reverse-proxy layer; if the origin is nginx, use them as-is.
If production fronts on Apache2, mirror the same map/return-410 logic into
the production vhost (Apache2 supports 'Return' via mod_alias and
Map/SetEnvIf via mod_rewrite).

To complete b1cd297e you need to know WHERE production autoplans.dev is
served and apply the equivalent block at that layer.
