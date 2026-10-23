const http = require('node:http');
const crypto = require('node:crypto');
const { shell } = require('electron');

const GRAPH_API = 'https://graph.microsoft.com/v1.0';
const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const CALLBACK_PATH = '/';
const b64url = (value) => value.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

async function connectOutlookCalendar({ clientId }) {
  if (!clientId?.trim()) throw new Error('Enter the Microsoft application (client) ID first.');
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const callback = await new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://localhost');
      if (request.method !== 'GET' || url.pathname !== CALLBACK_PATH) { response.writeHead(404).end(); return; }
      if (url.searchParams.get('state') !== state) { response.writeHead(400).end('Invalid sign-in state. You can close this tab.'); clearTimeout(timeout); server.close(); reject(new Error('Microsoft returned an invalid sign-in state.')); return; }
      const error = url.searchParams.get('error');
      response.writeHead(error ? 400 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(error ? '<h2>Outlook sign-in was not completed</h2><p>Return to Local Dashboard to try again.</p>' : '<h2>Outlook Calendar connected</h2><p>You can return to Local Dashboard.</p>');
      clearTimeout(timeout); server.close();
      error ? reject(new Error(`${error}: ${url.searchParams.get('error_description') || 'authorization was not completed'}`)) : resolve({ code: url.searchParams.get('code'), redirectUri, verifier });
    });
    const timeout = setTimeout(() => { server.close(); reject(new Error('Microsoft sign-in timed out.')); }, 180000);
    server.on('error', (error) => { clearTimeout(timeout); reject(new Error(`Could not open the Microsoft OAuth callback listener: ${error.message}`)); });
    server.listen(0, '127.0.0.1', async () => {
      const redirectUri = `http://localhost:${server.address().port}`;
      const authUrl = new URL(`${AUTHORITY}/authorize`);
      for (const [key, value] of Object.entries({
        client_id: clientId.trim(), response_type: 'code', redirect_uri: redirectUri,
        response_mode: 'query', scope: 'openid profile email offline_access User.Read Calendars.Read',
        code_challenge: challenge, code_challenge_method: 'S256', state, prompt: 'select_account',
      })) authUrl.searchParams.set(key, value);
      try { await shell.openExternal(authUrl.toString()); }
      catch (error) { clearTimeout(timeout); server.close(); reject(error); }
    });
  });
  const body = new URLSearchParams({ client_id: clientId.trim(), grant_type: 'authorization_code', code: callback.code, redirect_uri: callback.redirectUri, code_verifier: callback.verifier, scope: 'openid profile email offline_access User.Read Calendars.Read' });
  const response = await fetch(`${AUTHORITY}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const token = await response.json();
  if (!response.ok) throw new Error(token.error_description || `Microsoft token request failed (${response.status}).`);
  token.expires_at = Date.now() + Number(token.expires_in || 3600) * 1000;
  const user = await graphFetch(`${GRAPH_API}/me?$select=displayName,mail,userPrincipalName`, token);
  return { token, email: user.mail || user.userPrincipalName || '', name: user.displayName || '' };
}

async function refreshOutlookToken(clientId, token) {
  if (!token.refresh_token) throw new Error('Microsoft did not provide a refresh token. Remove this account and connect it again.');
  const body = new URLSearchParams({ client_id: clientId, grant_type: 'refresh_token', refresh_token: token.refresh_token, scope: 'openid profile email offline_access User.Read Calendars.Read' });
  const response = await fetch(`${AUTHORITY}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const renewed = await response.json();
  if (!response.ok) throw new Error(renewed.error_description || `Microsoft token refresh failed (${response.status}).`);
  return { ...token, ...renewed, refresh_token: renewed.refresh_token || token.refresh_token, expires_at: Date.now() + Number(renewed.expires_in || 3600) * 1000 };
}

async function graphFetch(url, token) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token.access_token}`, Prefer: 'outlook.timezone="UTC", odata.maxpagesize=500' } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(body.error?.message || `Microsoft Graph request failed (${response.status}).`); error.status = response.status; throw error; }
  return body;
}

async function listOutlookCalendars(token) {
  const calendars = [];
  let next = `${GRAPH_API}/me/calendars?$top=100`;
  while (next) {
    const page = await graphFetch(next, token);
    calendars.push(...(page.value || [])); next = page['@odata.nextLink'] || null;
  }
  return calendars;
}

async function syncOutlookCalendar({ clientId, token, integrationId, calendars, getSyncToken, saveSyncToken, importEvents, deleteEvents }) {
  if (Date.now() >= token.expires_at) token = await refreshOutlookToken(clientId, token);
  const now = new Date();
  const start = new Date(now); start.setUTCFullYear(start.getUTCFullYear() - 1);
  const end = new Date(now); end.setUTCFullYear(end.getUTCFullYear() + 2);
  let recordCount = 0;
  for (const calendar of calendars) {
    let next = getSyncToken(calendar.id);
    const windowStartDate = calendar.sync_window_start ? new Date(calendar.sync_window_start) : null;
    const refreshThreshold = new Date(now); refreshThreshold.setUTCDate(refreshThreshold.getUTCDate() - 365 - 270);
    const fullRefresh = next && windowStartDate && windowStartDate < refreshThreshold;
    if (fullRefresh) {
      deleteEvents(calendar.integration_id, calendar.external_calendar_id, null);
      saveSyncToken(calendar.id, null);
      next = null;
    }
    const fullSync = !next;
    if (!next) {
      const query = new URLSearchParams({ startDateTime: start.toISOString(), endDateTime: end.toISOString() });
      next = `${GRAPH_API}/me/calendars/${encodeURIComponent(calendar.external_calendar_id)}/calendarView/delta?${query}`;
    }
    let deltaLink;
    try {
      do {
        const page = await graphFetch(next, token);
        const upserts = []; const removals = [];
        for (const event of page.value || []) {
          const externalId = `calendar:${integrationId}:${calendar.external_calendar_id}:${event.id}`;
          if (event['@removed'] || event.isCancelled) { removals.push(externalId); continue; }
          const rawStart = event.start?.dateTime || '';
          const rawEnd = event.end?.dateTime || '';
          if (!rawStart || !rawEnd) continue;
          const allDay = Boolean(event.isAllDay);
          const startAt = allDay ? rawStart.slice(0, 10) : normalizeGraphDateTime(rawStart);
          const endAt = allDay ? rawEnd.slice(0, 10) : normalizeGraphDateTime(rawEnd);
          upserts.push({
            id: `event-${crypto.createHash('sha256').update(externalId).digest('hex').slice(0, 24)}`,
            externalId, occurredAt: startAt,
            payload: {
              title: event.subject || '(No title)', detail: event.bodyPreview || '', description: event.bodyPreview || '',
              location: event.location?.displayName || '', startAt, endAt, allDay,
              calendarId: calendar.external_calendar_id, calendarName: calendar.summary, calendarColor: calendar.color || '',
              source: 'Outlook Calendar', sourceAccount: calendar.account_label || '', sourceName: calendar.account_label ? `${calendar.summary} · ${calendar.account_label}` : calendar.summary || 'Outlook Calendar',
              providerEventId: event.id, iCalUID: event.iCalUId || '', webLink: event.webLink || '',
              timezone: allDay ? '' : 'UTC', color: 'blue', category: 'connected',
            },
          });
        }
        recordCount += importEvents(calendar.integration_id, upserts);
        deleteEvents(calendar.integration_id, calendar.external_calendar_id, removals);
        next = page['@odata.nextLink'] || null;
        deltaLink = page['@odata.deltaLink'] || deltaLink;
      } while (next);
      if (deltaLink) saveSyncToken(calendar.id, deltaLink, start.toISOString(), end.toISOString());
    } catch (error) {
      if (error.status === 410 && !fullSync) {
        deleteEvents(calendar.integration_id, calendar.external_calendar_id, null);
        saveSyncToken(calendar.id, null);
        const fresh = await syncOutlookCalendar({ clientId, token, integrationId, calendars: [{ ...calendar, sync_token: null }], getSyncToken: () => null, saveSyncToken, importEvents, deleteEvents });
        recordCount += fresh.recordCount; token = fresh.token;
      } else throw error;
    }
  }
  return { token, recordCount, calendarCount: calendars.length };
}

function normalizeGraphDateTime(value) {
  const normalized = `${String(value).replace(/\.(\d{3})\d+$/, '.$1').replace(/Z$/, '')}Z`;
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) throw new Error(`Microsoft returned an invalid event time: ${value}`);
  return date.toISOString();
}

module.exports = { connectOutlookCalendar, listOutlookCalendars, syncOutlookCalendar };
