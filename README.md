# Venn x DepositCloud enrollment demo

A static demo of how the partner app "Venn" would embed DepositCloud's
enrollment flow in an iframe. Plain HTML, CSS and vanilla JavaScript — no
build step, no framework, no third-party scripts.

Live demo: https://spadavecchia.github.io/venn-depositcloud-demo/

## Running it locally

The redirect-capture logic reads `iframe.contentWindow.location.href` and
listens for `postMessage`, both of which require the page to be served over
HTTP (not opened as a `file://` URL — browsers block `URL`/`location` access
and treat `file://` pages as opaque, unrelated origins).

From this folder:

```
python3 -m http.server 8000
```

Then open `http://localhost:8000/`.

## Publishing to GitHub Pages

1. Push the contents of this folder to the `main` branch of a repo named
   `venn-depositcloud-demo`.
2. In the repo settings, enable GitHub Pages for the `main` branch, folder
   `/` (root).
3. GitHub serves it at `https://<org-or-user>.github.io/venn-depositcloud-demo/`.

Because the Return URL is computed at runtime as
`location.origin + location.pathname.replace(/[^/]*$/, '') + 'return.html'`,
it resolves correctly whether the site is served from a domain root or from
a GitHub Pages project path — no hardcoded path needed.

## The contract this demo exercises

**Launch URL**

```
<host><path>?launch_token=<JWT>
```

- `host` defaults to `https://test.depositcloud.com`.
- `path` defaults to `/enrollment/property/55d5a7763daad4bd/general_pricing_config`.

**Launch token (JWT, HS256)**

Header:

```json
{ "alg": "HS256", "typ": "JWT" }
```

Payload:

```json
{
  "iss": "venn",
  "aud": "depositcloud",
  "sub": "<resident id>",
  "iat": 1700000000,
  "exp": 1700000300,
  "jti": "<uuid>",
  "email": "optional",
  "dob": "optional, YYYY-MM-DD",
  "lease_id": "optional",
  "unit_number": "optional"
}
```

`email`, `dob`, `lease_id` and `unit_number` are only included when filled
in. `sub` and the signing secret are required — the demo blocks the launch
with an inline message if either is blank.

The token is `base64url(header).base64url(payload).base64url(hmac_sha256(secret, header.payload))`,
signed in the browser with WebCrypto (`crypto.subtle`).

**Return URL**

DepositCloud navigates the iframe to the configured return URL with query
params:

- `status` — `success` or `failed`
- `dc_account` — the DepositCloud account id
- `reason` — optional failure code, present only when `status=failed`

The demo detects this two ways: by inspecting the iframe's `location.href`
once it lands back on this site's own origin, and via a `postMessage` sent
by `return.html` itself. Both are wired up; whichever fires first wins.

## Security note

Signing the launch token in the browser, with the secret typed into a
plain form field, is **only safe for this demo**. A real Venn integration
must build and sign this token **server-side**, using a secret stored
outside the browser (backend config/secret manager), and pass only the
finished token — never the raw secret — to the client.
