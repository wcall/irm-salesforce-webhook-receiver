// receiver.js — Express endpoint
// npm install express node-fetch

import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

// --- Salesforce OAuth2 (Connected App credentials) ---
const SF_AUTH_URL   = process.env.SF_AUTH_URL;   // e.g. https://login.salesforce.com/services/oauth2/token
const SF_CLIENT_ID  = process.env.SF_CLIENT_ID;
const SF_CLIENT_SECRET = process.env.SF_CLIENT_SECRET;
const SF_USERNAME   = process.env.SF_USERNAME;
const SF_PASSWORD   = process.env.SF_PASSWORD;   // password + security token

// Inbound auth is OPTIONAL. If SHARED_SECRET is set (non-empty after trimming),
// requests must send `Authorization: Bearer <SHARED_SECRET>`. If it is unset/
// empty, the auth check is skipped entirely and any caller that can reach the
// endpoint may create cases — rely on the network/Security Group in that case.
const SHARED_SECRET = process.env.SHARED_SECRET?.trim();
const AUTH_ENABLED  = !!SHARED_SECRET;

// --- Startup config log ---
if (AUTH_ENABLED) {
  console.log(`[startup] Inbound auth ENABLED — expecting "Authorization: Bearer <SHARED_SECRET>" (secret length: ${SHARED_SECRET.length})`);
} else {
  console.warn('[startup] Inbound auth DISABLED — SHARED_SECRET is not set, so /salesforce/case accepts unauthenticated requests. Restrict access via the EC2 Security Group, or set SHARED_SECRET to lock it down.');
}

/*
async function getSFToken() {
  const params = new URLSearchParams({
    grant_type:    'password',
    client_id:     SF_CLIENT_ID,
    client_secret: SF_CLIENT_SECRET,
    username:      SF_USERNAME,
    password:      SF_PASSWORD,
  });
  const res = await fetch(SF_AUTH_URL, { method: 'POST', body: params });
  const data = await res.json();
  if (!data.access_token) throw new Error(`SF auth failed: ${JSON.stringify(data)}`);
  return { token: data.access_token, instanceUrl: data.instance_url };
} */

async function getSFToken() {
    const params = new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     SF_CLIENT_ID,
      client_secret: SF_CLIENT_SECRET,
    });
    const res = await fetch(SF_AUTH_URL, { method: 'POST', body: params });
    const data = await res.json();
    if (!data.access_token) throw new Error(`SF auth failed: ${JSON.stringify(data)}`);
    return { token: data.access_token, instanceUrl: data.instance_url };
}

// Severity → SF Case Priority mapping
const SEVERITY_MAP = {
  critical: 'High',
  high:     'High',
  medium:   'Medium',
  low:      'Low',
};

app.post('/salesforce/case', async (req, res) => {
  // Inbound auth check — only enforced when SHARED_SECRET is configured.
  if (AUTH_ENABLED) {
    const auth = req.headers['authorization'];
    const expected = `Bearer ${SHARED_SECRET}`;
    if (auth !== expected) {
      console.warn('[auth] rejected: Authorization header missing or does not match SHARED_SECRET');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    console.log('[auth] OK — request authorized');
  } else {
    console.log('[auth] skipped — SHARED_SECRET not set (auth disabled)');
  }

  const { subject, description, severity, irm_incident_id, origin } = req.body;

  try {
    const { token, instanceUrl } = await getSFToken();

    const casePayload = {
      Subject:     subject || 'Grafana IRM Incident',
      Description: description || 'Grafana IRM Demo' + Date.now(),
      Priority:    SEVERITY_MAP[severity?.toLowerCase()] || 'Medium',
      Origin:      origin || 'Grafana IRM',
      // Optional: map to a custom SF field
      IRM_Incident_ID__c: irm_incident_id || 'Grafana IRM Demo' + Date.now(),
    };

    const sfRes = await fetch(`${instanceUrl}/services/data/v59.0/sobjects/Case`, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(casePayload),
    });

    const sfData = await sfRes.json();

    if (!sfRes.ok) {
      console.error('SF error:', sfData);
      return res.status(502).json({ error: 'Salesforce rejected the case', detail: sfData });
    }

    console.log(`Case created: ${sfData.id} for IRM incident ${irm_incident_id}`);
    // Return case ID so IRM can store it via {{ responses }} for follow-up webhooks
    return res.status(201).json({ caseId: sfData.id, success: true });

  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => console.log('Receiver listening on :3000'));