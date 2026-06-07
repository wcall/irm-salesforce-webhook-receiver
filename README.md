# Grafana IRM → Salesforce Case Webhook

A small Express receiver that turns **Grafana IRM** outgoing webhooks into
**Salesforce Cases**. When an incident fires, IRM POSTs to this service, which
authenticates to Salesforce via OAuth2 and creates a `Case` record. The new
Case ID is returned so IRM can store it (via `{{ responses }}`) for follow-up
webhooks.

```
Grafana IRM ──POST /salesforce/case──▶ receiver.js ──POST sobjects/Case──▶ Salesforce
   (Bearer SHARED_SECRET)              (OAuth2 token)         (Case created)
```

## How it works

1. IRM sends a `POST /salesforce/case` with an `Authorization: Bearer <SHARED_SECRET>`
   header and a JSON body describing the incident.
2. The receiver verifies the shared secret (returns `401` if it doesn't match).
3. It fetches a Salesforce access token using the OAuth2 username-password flow.
4. It maps the incident `severity` to a Salesforce Case `Priority` and creates
   the Case at `<instanceUrl>/services/data/v59.0/sobjects/Case`.
5. On success it responds `201` with `{ "caseId": "<id>", "success": true }`.

The Salesforce REST target for case creation in this org is:

```
https://orgfarm-4cd415b5fa-dev-ed.develop.my.salesforce.com/services/data/v59.0/sobjects/Case
```

> Note: the receiver does **not** hardcode that URL. It derives `instance_url`
> from the OAuth2 token response, so it always writes to the correct instance.

## Request body

| Field             | Type   | Required | Notes                                              |
| ----------------- | ------ | -------- | -------------------------------------------------- |
| `subject`         | string | no       | Case Subject. Defaults to `Grafana IRM Incident`.  |
| `description`     | string | no       | Case Description.                                  |
| `severity`        | string | no       | `critical`/`high` → `High`, `medium` → `Medium`, `low` → `Low`. Defaults to `Medium`. |
| `origin`          | string | no       | Case Origin. Defaults to `Grafana IRM`.            |
| `irm_incident_id` | string | no       | IRM incident ID (logged; can be mapped to a custom SF field). |

### Severity → Priority mapping

| IRM severity | SF Case Priority |
| ------------ | ---------------- |
| `critical`   | `High`           |
| `high`       | `High`           |
| `medium`     | `Medium`         |
| `low`        | `Low`            |
| _(other)_    | `Medium`         |

## Prerequisites

- **Node.js 20+** (uses the built-in `--env-file` flag to load `.env`).
- A Salesforce **Connected App** with OAuth enabled (consumer key + secret) and
  the username-password OAuth flow allowed. See Salesforce's guide:
  [Create a Connected App](https://help.salesforce.com/s/articleView?id=platform.connected_app_create_basics.htm&type=5)
  (enable OAuth settings and the relevant scopes, e.g. `api`).
- A Salesforce **integration user** whose password + security token you can use,
  granted the minimum permissions needed to create Cases. See:
  [Create a permission set](https://help.salesforce.com/s/articleView?id=platform.perm_sets_create.htm&type=5)
  and [Reset your security token](https://help.salesforce.com/s/articleView?id=user_security_token.htm&type=5).

### Verifying your Connected App credentials

To confirm your Connected App's consumer key and secret are valid, request a
Salesforce access token directly. (This requires the **Client Credentials** flow
to be enabled on the Connected App and a "Run As" user assigned.)

```bash
curl -X POST https://orgfarm-4cd415b5fa-dev-ed.develop.my.salesforce.com/services/oauth2/token \
  -d "grant_type=client_credentials" \
  -d "client_id=<YOUR_CONSUMER_KEY>" \
  -d "client_secret=<YOUR_CONSUMER_SECRET>"
```

A successful response returns a Salesforce `access_token` (and `instance_url`),
which confirms the credentials work:

```json
{ "access_token": "00D...!AQ...", "instance_url": "https://...my.salesforce.com", "token_type": "Bearer", ... }
```

> **Note:** this `access_token` is a short-lived Salesforce API token — it is
> **not** the `SHARED_SECRET`. The receiver obtains its own token internally at
> runtime via the credentials in `.env`, so you don't paste this value anywhere.
> The `SHARED_SECRET` is a separate value **you generate yourself** (e.g.
> `openssl rand -hex 32`) and must match the `Authorization: Bearer <SHARED_SECRET>`
> header that Grafana IRM sends to this receiver.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Configure environment variables. Copy the example and fill in your values:

   ```bash
   cp .env.example .env
   ```

   | Variable           | Description                                                                 |
   | ------------------ | --------------------------------------------------------------------------- |
   | `SF_AUTH_URL`      | OAuth2 token endpoint (e.g. your My Domain `.../services/oauth2/token`).     |
   | `SF_CLIENT_ID`     | Connected App consumer key.                                                 |
   | `SF_CLIENT_SECRET` | Connected App consumer secret.                                              |
   | `SF_USERNAME`      | Integration user's username.                                                |
   | `SF_PASSWORD`      | Integration user's password **immediately followed by** the security token (no space). |
   | `SHARED_SECRET`    | Long random string; must match the Bearer token IRM sends.                  |

3. Run the receiver:

   ```bash
   npm start
   ```

   (or `npm run dev` for auto-reload on file changes). Both load `.env` via
   Node's built-in `--env-file` flag. It listens on port **3000**:
   `Receiver listening on :3000`.

## Configure Grafana IRM

Point an IRM outgoing webhook at this service:

- **URL**: `https://<your-host>/salesforce/case`
- **HTTP method**: `POST`
- **Headers**:
  - `Authorization: Bearer <SHARED_SECRET>`
  - `Content-Type: application/json`
- **Body** (example):

  ```json
  {
    "subject": "{{ incident.title }}",
    "description": "{{ incident.description }}",
    "severity": "{{ incident.severity }}",
    "origin": "Grafana IRM",
    "irm_incident_id": "{{ incident.id }}"
  }
  ```

The response `caseId` can be captured via `{{ responses }}` and reused in
follow-up webhooks (e.g. to update or close the Case).

## Test locally

```bash
curl -X POST http://localhost:3000/salesforce/case \
  -H "Authorization: Bearer $SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "subject": "Test incident from IRM",
    "description": "Created via local curl test",
    "severity": "critical",
    "irm_incident_id": "INC-123"
  }'
```

Expected: `201 Created` with `{ "caseId": "500...", "success": true }`.

## Responses

| Status | Meaning                                                        |
| ------ | -------------------------------------------------------------- |
| `201`  | Case created. Body: `{ caseId, success: true }`.              |
| `401`  | Missing/incorrect `Authorization` Bearer token.              |
| `502`  | Salesforce rejected the case. Body includes `detail`.        |
| `500`  | Unexpected error (e.g. Salesforce auth failure).             |

## Security notes

- **Never commit `.env`.** It holds Salesforce credentials and the shared secret.
  Add it to `.gitignore`.
- Use a strong, random `SHARED_SECRET` and rotate it periodically.
- Terminate TLS in front of this service (reverse proxy / load balancer) so the
  Bearer token is never sent in plaintext.
- Scope the Salesforce integration user to the minimum permissions needed to
  create Cases.
