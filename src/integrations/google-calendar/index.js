const http = require('node:http');
const crypto = require('node:crypto');
const { shell } = require('electron');

const CALLBACK_PATH = '/oauth/callback';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const TOKEN_API = 'https://oauth2.googleapis.com/token';
const USERINFO_API = 'https://www.googleapis.com/oauth2/v2/userinfo';
const base64url = (value) => value.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

function callbackPage(success) {
  const heading = success ? 'Google Calendar connected' : 'Google Calendar setup could not finish';
  const message = success
    ? 'Local Dashboard has finished connecting. This tab should close automatically.'
    : 'Return to Local Dashboard for details, then close this tab.';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${heading}</title></head><body><h2>${heading}</h2><p id="message">${message}</p><script>window.close();setTimeout(()=>{document.getElementById('message').textContent='Your browser did not allow this tab to close. You can close it now.'},400)</script></body></html>`;
}

async function connectGoogleCalendar({ clientId }, {
  openExternal = (url) => shell.openExternal(url), fetchImpl = fetch,
  createServer = (listener) => http.createServer(listener),
} = {}) {
  if (!clientId?.trim()) throw new Error('Enter the Google OAuth client ID first.');
  const state = base64url(crypto.randomBytes(24));
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  let callbackServer;
  const callback = await new Promise((resolve, reject) => {
    let redirectUri;
    let callbackReceived = false;
    const server = callbackServer = createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method !== 'GET' || url.pathname !== CALLBACK_PATH) { response.writeHead(404).end(); return; }
      if (callbackReceived) { response.writeHead(409).end(); return; }
      if (url.searchParams.get('state') !== state) { response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(callbackPage(false)); clearTimeout(timeout); server.close(); reject(new Error('Google returned an invalid OAuth state.')); return; }
      const error = url.searchParams.get('error');
      if (error) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(callbackPage(false));
        clearTimeout(timeout); server.close(); reject(new Error(`Google authorization failed: ${error}`)); return;
      }
      callbackReceived = true;
      clearTimeout(timeout);
      resolve({ code: url.searchParams.get('code'), redirectUri, verifier, response });
    });
    const timeout = setTimeout(() => { server.close(); reject(new Error('Google sign-in timed out.')); }, 180000);
    server.on('error', (error) => { clearTimeout(timeout); reject(new Error(`Could not open the Google OAuth callback listener: ${error.message}`)); });
    server.listen(0, '127.0.0.1', async () => {
      const address = server.address();
      redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      for (const [key, value] of Object.entries({
        client_id: clientId.trim(), redirect_uri: redirectUri, response_type: 'code',
        scope: 'openid email https://www.googleapis.com/auth/calendar.readonly',
        code_challenge: challenge, code_challenge_method: 'S256', state,
        access_type: 'offline', prompt: 'consent',
      })) authUrl.searchParams.set(key, value);
      try { await openExternal(authUrl.toString()); }
      catch (error) { clearTimeout(timeout); server.close(); reject(error); }
    });
  });
  let token;
  try {
    const body = new URLSearchParams({ client_id: clientId.trim(), code: callback.code, code_verifier: callback.verifier, grant_type: 'authorization_code', redirect_uri: callback.redirectUri });
    const response = await fetchImpl(TOKEN_API, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    token = await response.json();
    if (!response.ok) throw new Error(token.error_description || `Google token request failed (${response.status}).`);
    callback.response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(callbackPage(true));
  } catch (error) {
    callback.response.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(callbackPage(false));
    throw error;
  } finally {
    callbackServer.close();
  }
  token.expires_at = Date.now() + Number(token.expires_in || 3600) * 1000;
  const userResponse = await googleFetch(USERINFO_API, token, fetchImpl);
  return { token, email: userResponse.email || '', name: userResponse.name || '' };
}

async function refreshGoogleToken(clientId, token, fetchImpl = fetch) {
  if (!token.refresh_token) throw new Error('Google did not provide a refresh token. Remove this account and connect it again with consent.');
  const body = new URLSearchParams({ client_id: clientId, refresh_token: token.refresh_token, grant_type: 'refresh_token' });
  const response = await fetchImpl(TOKEN_API, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const renewed = await response.json();
  if (!response.ok) throw new Error(renewed.error_description || `Google token refresh failed (${response.status}).`);
  return { ...token, ...renewed, refresh_token: renewed.refresh_token || token.refresh_token, expires_at: Date.now() + Number(renewed.expires_in || 3600) * 1000 };
}

async function googleFetch(url, token, fetchImpl = fetch) {
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token.access_token}` } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `Google Calendar request failed (${response.status}).`);
  return body;
}

async function listGoogleCalendars(token) {
  const calendars = [];
  let pageToken;
  do {
    const url = new URL(`${CALENDAR_API}/users/me/calendarList`);
    url.searchParams.set('maxResults', '250');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const page = await googleFetch(url, token);
    calendars.push(...(page.items || [])); pageToken = page.nextPageToken;
  } while (pageToken);
  return calendars;
}

async function syncGoogleCalendar({ clientId, token, integrationId, calendars, getSyncToken, saveSyncToken, importEvents, deleteEvents }, { fetchImpl = fetch } = {}) {
  if (Date.now() >= token.expires_at) token = await refreshGoogleToken(clientId, token, fetchImpl);
  const headers = { Authorization: `Bearer ${token.access_token}` };
  const request = async (url) => {
    const response = await fetchImpl(url, { headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(body.error?.message || `Google Calendar request failed (${response.status}).`); error.status = response.status; throw error; }
    return body;
  };
  let recordCount = 0;
  for (const calendar of calendars) {
    let syncToken = getSyncToken(calendar.id);
    const fullSync = !syncToken;
    let pageToken; let nextSyncToken;
    try {
      do {
        const url = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(calendar.external_calendar_id)}/events`);
        url.searchParams.set('singleEvents', 'true'); url.searchParams.set('showDeleted', 'true'); url.searchParams.set('maxResults', '2500');
        if (syncToken) url.searchParams.set('syncToken', syncToken);
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        const page = await request(url);
        const upserts = []; const removals = [];
        for (const event of page.items || []) {
          const externalId = `calendar:${integrationId}:${calendar.external_calendar_id}:${event.id}`;
          if (event.status === 'cancelled') { removals.push(externalId); continue; }
          const startAt = event.start?.dateTime || event.start?.date;
          const endAt = event.end?.dateTime || event.end?.date;
          if (!startAt || !endAt) continue;
          upserts.push({
            id: `event-${crypto.createHash('sha256').update(externalId).digest('hex').slice(0, 24)}`,
            externalId, occurredAt: startAt,
            payload: {
              title: event.summary || '(No title)', detail: event.description || '', description: event.description || '',
              location: event.location || '', startAt, endAt, allDay: Boolean(event.start?.date),
              calendarId: calendar.external_calendar_id, calendarName: calendar.summary, calendarColor: calendar.color || '',
              source: 'Google Calendar', sourceAccount: calendar.account_label || '', sourceName: calendar.account_label ? `${calendar.summary} · ${calendar.account_label}` : calendar.summary || 'Google Calendar',
              providerEventId: event.id, iCalUID: event.iCalUID || '', htmlLink: event.htmlLink || '', status: event.status,
              transparency: event.transparency || 'opaque', timezone: event.start?.timeZone || calendar.timezone || '',
              color: 'blue', category: 'connected',
            },
          });
        }
        recordCount += importEvents(calendar.integration_id, upserts);
        deleteEvents(calendar.integration_id, calendar.external_calendar_id, removals);
        pageToken = page.nextPageToken; nextSyncToken = page.nextSyncToken || nextSyncToken;
      } while (pageToken);
      if (nextSyncToken) saveSyncToken(calendar.id, nextSyncToken);
    } catch (error) {
      if (error.status === 410 && !fullSync) {
        deleteEvents(calendar.integration_id, calendar.external_calendar_id, null);
        saveSyncToken(calendar.id, null);
        const fresh = await syncGoogleCalendar({ clientId, token, integrationId, calendars: [{ ...calendar, sync_token: null }], getSyncToken: () => null, saveSyncToken, importEvents, deleteEvents }, { fetchImpl });
        recordCount += fresh.recordCount; token = fresh.token;
      } else throw error;
    }
  }
  return { token, recordCount, calendarCount: calendars.length };
}

module.exports = { connectGoogleCalendar, listGoogleCalendars, syncGoogleCalendar };
