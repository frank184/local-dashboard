const http = require('node:http');
const crypto = require('node:crypto');
const { shell } = require('electron');

const CALLBACK_PATH = '/oauth/callback';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const TOKEN_API = 'https://oauth2.googleapis.com/token';
const USERINFO_API = 'https://www.googleapis.com/oauth2/v2/userinfo';
const base64url = (value) => value.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

async function connectGoogleCalendar({ clientId }) {
  if (!clientId?.trim()) throw new Error('Enter the Google OAuth client ID first.');
  const state = base64url(crypto.randomBytes(24));
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const callback = await new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method !== 'GET' || url.pathname !== CALLBACK_PATH) { response.writeHead(404).end(); return; }
      if (url.searchParams.get('state') !== state) { response.writeHead(400).end('Invalid OAuth state. You can close this tab.'); clearTimeout(timeout); server.close(); reject(new Error('Google returned an invalid OAuth state.')); return; }
      const error = url.searchParams.get('error');
      response.writeHead(error ? 400 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(error ? '<h2>Google sign-in was not completed</h2><p>Return to Local Dashboard to try again.</p>' : '<h2>Google Calendar connected</h2><p>You can return to Local Dashboard.</p>');
      clearTimeout(timeout); server.close();
      error ? reject(new Error(`Google authorization failed: ${error}`)) : resolve({ code: url.searchParams.get('code'), redirectUri, verifier });
    });
    const timeout = setTimeout(() => { server.close(); reject(new Error('Google sign-in timed out.')); }, 180000);
    server.on('error', (error) => { clearTimeout(timeout); reject(new Error(`Could not open the Google OAuth callback listener: ${error.message}`)); });
    server.listen(0, '127.0.0.1', async () => {
      const address = server.address();
      const redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      for (const [key, value] of Object.entries({
        client_id: clientId.trim(), redirect_uri: redirectUri, response_type: 'code',
        scope: 'openid email https://www.googleapis.com/auth/calendar.readonly',
        code_challenge: challenge, code_challenge_method: 'S256', state,
        access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
      })) authUrl.searchParams.set(key, value);
      try { await shell.openExternal(authUrl.toString()); }
      catch (error) { clearTimeout(timeout); server.close(); reject(error); }
    });
  });
  const body = new URLSearchParams({ client_id: clientId.trim(), code: callback.code, code_verifier: callback.verifier, grant_type: 'authorization_code', redirect_uri: callback.redirectUri });
  const response = await fetch(TOKEN_API, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const token = await response.json();
  if (!response.ok) throw new Error(token.error_description || `Google token request failed (${response.status}).`);
  token.expires_at = Date.now() + Number(token.expires_in || 3600) * 1000;
  const userResponse = await googleFetch(USERINFO_API, token);
  return { token, email: userResponse.email || '', name: userResponse.name || '' };
}

async function refreshGoogleToken(clientId, token) {
  if (!token.refresh_token) throw new Error('Google did not provide a refresh token. Remove this account and connect it again with consent.');
  const body = new URLSearchParams({ client_id: clientId, refresh_token: token.refresh_token, grant_type: 'refresh_token' });
  const response = await fetch(TOKEN_API, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const renewed = await response.json();
  if (!response.ok) throw new Error(renewed.error_description || `Google token refresh failed (${response.status}).`);
  return { ...token, ...renewed, refresh_token: renewed.refresh_token || token.refresh_token, expires_at: Date.now() + Number(renewed.expires_in || 3600) * 1000 };
}

async function googleFetch(url, token) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token.access_token}` } });
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

async function syncGoogleCalendar({ clientId, token, integrationId, calendars, getSyncToken, saveSyncToken, importEvents, deleteEvents }) {
  if (Date.now() >= token.expires_at) token = await refreshGoogleToken(clientId, token);
  const headers = { Authorization: `Bearer ${token.access_token}` };
  const request = async (url) => {
    const response = await fetch(url, { headers });
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
        const fresh = await syncGoogleCalendar({ clientId, token, integrationId, calendars: [{ ...calendar, sync_token: null }], getSyncToken: () => null, saveSyncToken, importEvents, deleteEvents });
        recordCount += fresh.recordCount; token = fresh.token;
      } else throw error;
    }
  }
  return { token, recordCount, calendarCount: calendars.length };
}

module.exports = { connectGoogleCalendar, listGoogleCalendars, syncGoogleCalendar };
