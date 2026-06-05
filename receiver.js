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
  if (auth !== `Bearer ${SHARED_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

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