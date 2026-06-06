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
const SHARED_SECRET = process.env.SHARED_SECRET; // must match IRM Authorization header

// --- Startup config debug (remove or guard in production) ---
// Reveals whether SHARED_SECRET actually loaded from .env, and flags hidden
// quotes/whitespace that break the exact-string auth comparison below.
console.log('[startup] SHARED_SECRET present:', SHARED_SECRET !== undefined && SHARED_SECRET !== '');
if (SHARED_SECRET !== undefined) {
  console.log('[startup] SHARED_SECRET length:', SHARED_SECRET.length);
  console.log('[startup] SHARED_SECRET JSON :', JSON.stringify(SHARED_SECRET)); // quotes expose surrounding spaces/quotes
  if (SHARED_SECRET !== SHARED_SECRET.trim()) {
    console.warn('[startup] WARNING: SHARED_SECRET has leading/trailing whitespace!');
  }
} else {
  console.warn('[startup] WARNING: SHARED_SECRET is undefined — every request will 401. Check .env and that you run with --env-file=.env');
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
    console.log('getSFToken: SF token:', data.access_token);
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
  // Auth check
  const auth = req.headers['authorization'];
  const expected = `Bearer ${SHARED_SECRET}`;

  // --- Auth debug (remove in production: prints the secret) ---
  console.log('--- AUTH DEBUG ---');
  console.log('[auth] header present  :', auth !== undefined);
  console.log('[auth] received        :', JSON.stringify(auth));
  console.log('[auth] expected        :', JSON.stringify(expected));
  console.log('[auth] received length :', auth ? auth.length : 'n/a', '| expected length:', expected.length);
  console.log('[auth] match           :', auth === expected);
  if (auth && auth !== expected) {
    if (!auth.startsWith('Bearer ')) {
      console.warn('[auth] mismatch reason: header does not start with "Bearer " prefix');
    } else if (auth.trim() === expected.trim()) {
      console.warn('[auth] mismatch reason: only differs by leading/trailing whitespace');
    } else {
      console.warn('[auth] mismatch reason: token value differs from SHARED_SECRET');
    }
  }

  if (auth !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  console.log('[auth] OK — request authorized');

  const { subject, description, severity, irm_incident_id, origin } = req.body;

  try {
    const { token, instanceUrl } = await getSFToken();

    const casePayload = {
      Subject:     subject || 'Grafana IRM Incident',
      Description: description,
      Priority:    SEVERITY_MAP[severity?.toLowerCase()] || 'Medium',
      Origin:      origin || 'Grafana IRM',
      // Optional: map to a custom SF field
      // IRM_Incident_ID__c: irm_incident_id,
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