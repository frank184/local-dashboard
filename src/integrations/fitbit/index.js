const http = require('node:http');
const crypto = require('node:crypto');
const { shell } = require('electron');

const CALLBACK_PORT = 53682;
const CALLBACK_PATH = '/oauth/callback';
const CALLBACK_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;
function base64url(value) { return value.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function pkcePair() {
  const verifier = base64url(crypto.randomBytes(48));
  return { verifier, challenge: base64url(crypto.createHash('sha256').update(verifier).digest()) };
}

async function connectFitbit({ clientId }) {
  if (!clientId?.trim()) throw new Error('Enter the Fitbit OAuth client ID first.');
  const state = base64url(crypto.randomBytes(24));
  const { verifier, challenge } = pkcePair();
  const code = await new Promise((resolve, reject) => {
    let callbackServer;
    const timeout = setTimeout(() => { callbackServer?.close(); reject(new Error('Fitbit sign-in timed out.')); }, 180000);
    callbackServer = http.createServer((req, res) => {
      const callback = new URL(req.url, CALLBACK_URI);
      if (req.method !== 'GET' || callback.pathname !== CALLBACK_PATH) { res.writeHead(404).end(); return; }
      if (callback.searchParams.get('state') !== state) { res.writeHead(400).end('Invalid OAuth state.'); clearTimeout(timeout); callbackServer.close(); reject(new Error('Fitbit returned an invalid OAuth state.')); return; }
      const oauthError = callback.searchParams.get('error');
      if (oauthError) { res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Fitbit authorization was not completed. You can close this tab.'); clearTimeout(timeout); callbackServer.close(); reject(new Error(`Fitbit authorization failed: ${oauthError}`)); return; }
      const authCode = callback.searchParams.get('code');
      res.writeHead(authCode ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' }).end(authCode ? '<h2>Fitbit connected</h2><p>You can return to Local Dashboard.</p>' : '<h2>Sign-in incomplete</h2><p>Return to Local Dashboard and try again.</p>');
      clearTimeout(timeout); callbackServer.close();
      authCode ? resolve(authCode) : reject(new Error('Fitbit did not return an authorization code.'));
    });
    callbackServer.on('error', (error) => { clearTimeout(timeout); reject(new Error(`Could not open the Fitbit callback listener on port ${CALLBACK_PORT}: ${error.message}`)); });
    callbackServer.listen(CALLBACK_PORT, '127.0.0.1', async () => {
      const authUrl = new URL('https://www.fitbit.com/oauth2/authorize');
      for (const [key, value] of Object.entries({ response_type: 'code', client_id: clientId.trim(), redirect_uri: CALLBACK_URI, scope: 'sleep weight', code_challenge: challenge, code_challenge_method: 'S256', state })) authUrl.searchParams.set(key, value);
      try { await shell.openExternal(authUrl.toString()); }
      catch (error) { clearTimeout(timeout); callbackServer.close(); reject(error); }
    });
  });
  const body = new URLSearchParams({ client_id: clientId.trim(), grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CALLBACK_URI });
  const response = await fetch('https://api.fitbit.com/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const token = await response.json();
  if (!response.ok) throw new Error(token.errors?.[0]?.message || `Fitbit token request failed (${response.status}).`);
  return token;
}

async function refreshFitbitToken(clientId, token) {
  const body = new URLSearchParams({ client_id: clientId, grant_type: 'refresh_token', refresh_token: token.refresh_token });
  const response = await fetch('https://api.fitbit.com/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const renewed = await response.json();
  if (!response.ok) throw new Error(renewed.errors?.[0]?.message || `Fitbit token refresh failed (${response.status}).`);
  return renewed;
}

async function syncFitbit({ clientId, token, integrationId }) {
  if (Date.now() >= token.expires_at) token = await refreshFitbitToken(clientId, token);
  const headers = { Authorization: `Bearer ${token.access_token}` };
  const items = [];
  for (let offset = 13; offset >= 0; offset -= 1) {
    const date = new Date(); date.setDate(date.getDate() - offset);
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const grantedScopes = new Set(String(token.scope || 'sleep weight').split(/\s+/));
    const [sleepResponse, weightResponse] = await Promise.all([
      grantedScopes.has('sleep') ? fetch(`https://api.fitbit.com/1.2/user/-/sleep/date/${day}.json`, { headers }) : null,
      grantedScopes.has('weight') ? fetch(`https://api.fitbit.com/1/user/-/body/log/weight/date/${day}.json`, { headers }) : null,
    ]);
    const sleepData = sleepResponse ? await sleepResponse.json() : {};
    const weightData = weightResponse ? await weightResponse.json() : {};
    if ((sleepResponse && !sleepResponse.ok) || (weightResponse && !weightResponse.ok)) {
      const failed = sleepResponse && !sleepResponse.ok ? sleepData : weightData;
      throw new Error(failed.errors?.[0]?.message || `Fitbit data request failed (${sleepResponse && !sleepResponse.ok ? sleepResponse.status : weightResponse.status}).`);
    }
    for (const sleep of sleepData.sleep || []) {
      const minutes = Number(sleep.minutesAsleep ?? sleep.duration / 60000);
      if (!Number.isFinite(minutes)) continue;
      const id = `fitbit:${integrationId}:sleep:${sleep.logId}`;
      items.push({ id, recordType: 'health_sleep', externalId: id, occurredAt: new Date(sleep.startTime).toISOString(), payload: { durationHours: Number((minutes / 60).toFixed(2)), dateOfSleep: sleep.dateOfSleep, sleepStages: sleep.levels?.summary || {}, source: 'Fitbit', sourceLogId: String(sleep.logId) } });
    }
    for (const weight of weightData.weight || []) {
      const id = `fitbit:${integrationId}:weight:${weight.logId}`;
      items.push({ id, recordType: 'health_weight', externalId: id, occurredAt: new Date(`${weight.date}T${weight.time || '12:00:00'}`).toISOString(), payload: { kilograms: Number(weight.weight), bodyFatPercent: Number.isFinite(Number(weight.fat)) ? Number(weight.fat) : null, source: 'Fitbit', sourceLogId: String(weight.logId) } });
    }
  }
  return { token, items };
}

module.exports = { connectFitbit, syncFitbit, CALLBACK_URI };
