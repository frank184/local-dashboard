const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { describe, it } = require('node:test');
const { connectGoogleCalendar, syncGoogleCalendar } = require('../../../src/integrations/google-calendar');

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('Google Calendar OAuth request sequence', () => {
it('requests read-only scopes and exchanges the authorization code with PKCE before loading identity', async () => {
  const calls = [];
  const sequence = [];
  let callbackPage;
  let authorizationUrl;
  let callbackHandler;
  const result = await connectGoogleCalendar({ clientId: 'desktop-client-id' }, {
    openExternal(authUrl) {
      sequence.push('authorize');
      authorizationUrl = authUrl;
      const authorization = new URL(authUrl);
      const redirectUri = authorization.searchParams.get('redirect_uri');
      const callbackUrl = new URL(redirectUri);
      callbackUrl.searchParams.set('state', authorization.searchParams.get('state'));
      callbackUrl.searchParams.set('code', 'authorization-code');
      // Simulate the browser returning to the temporary loopback listener.
      callbackPage = new Promise((resolve) => {
        callbackHandler({ method: 'GET', url: `${callbackUrl.pathname}${callbackUrl.search}` }, {
          writeHead(status) { this.status = status; return this; },
          end(body) { resolve({ status: this.status, body }); },
        });
      });
    },
    createServer(handler) {
      callbackHandler = handler;
      return {
        on() {},
        listen(_port, _host, callback) { callback(); },
        address() { return { port: 43123 }; },
        close() {},
      };
    },
    async fetchImpl(url, options) {
      calls.push({ url: String(url), options });
      if (url === 'https://oauth2.googleapis.com/token') {
        sequence.push('exchange');
        return jsonResponse({ access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600 });
      }
      if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') {
        sequence.push('userinfo');
        return jsonResponse({ email: 'person@example.com', name: 'Example Person' });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(calls[1].url, 'https://www.googleapis.com/oauth2/v2/userinfo');
  assert.deepEqual(sequence, ['authorize', 'exchange', 'userinfo']);
  assert.equal(result.email, 'person@example.com');
  assert.equal(result.name, 'Example Person');
  assert.equal(result.token.refresh_token, 'refresh-token');

  const authorization = new URL(authorizationUrl);
  assert.equal(authorization.origin + authorization.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(authorization.searchParams.get('client_id'), 'desktop-client-id');
  assert.equal(authorization.searchParams.get('response_type'), 'code');
  assert.equal(authorization.searchParams.get('scope'), 'openid email https://www.googleapis.com/auth/calendar.readonly');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.get('access_type'), 'offline');
  assert.equal(authorization.searchParams.get('prompt'), 'consent');
  assert.equal(authorization.searchParams.has('include_granted_scopes'), false);

  const exchangeBody = new URLSearchParams(calls[0].options.body);
  assert.deepEqual(Object.fromEntries(exchangeBody), {
    client_id: 'desktop-client-id',
    code: 'authorization-code',
    code_verifier: exchangeBody.get('code_verifier'),
    grant_type: 'authorization_code',
    redirect_uri: authorization.searchParams.get('redirect_uri'),
  });
  assert.equal(exchangeBody.has('client_secret'), false);
  assert.equal(exchangeBody.get('code_verifier').length, 64);
  const expectedChallenge = crypto.createHash('sha256').update(exchangeBody.get('code_verifier')).digest('base64url');
  assert.equal(authorization.searchParams.get('code_challenge'), expectedChallenge);
  const page = await callbackPage;
  assert.equal(page.status, 200);
  assert.match(page.body, /Google Calendar connected/);
});

it('refreshes an expired access token before calling the Calendar API', async () => {
  const calls = [];
  const currentToken = {
    access_token: 'expired-access-token', refresh_token: 'stored-refresh-token', expires_at: 0,
  };
  const result = await syncGoogleCalendar({
    clientId: 'desktop-client-id', token: currentToken, integrationId: 'integration-1',
    calendars: [{ id: 'calendar-1', integration_id: 'integration-1', external_calendar_id: 'primary', summary: 'Primary' }],
    getSyncToken: () => null, saveSyncToken() {}, importEvents: () => 0, deleteEvents() {},
  }, {
    async fetchImpl(url, options) {
      calls.push({ url: String(url), options });
      if (url === 'https://oauth2.googleapis.com/token') {
        return jsonResponse({ access_token: 'renewed-access-token', expires_in: 3600 });
      }
      assert.match(String(url), /^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/primary\/events/);
      return jsonResponse({ items: [], nextSyncToken: 'sync-1' });
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(calls[1].url.startsWith('https://www.googleapis.com/calendar/v3/'), true);
  const refreshBody = new URLSearchParams(calls[0].options.body);
  assert.deepEqual(Object.fromEntries(refreshBody), {
    client_id: 'desktop-client-id', refresh_token: 'stored-refresh-token', grant_type: 'refresh_token',
  });
  assert.equal(refreshBody.has('client_secret'), false);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer renewed-access-token');
  assert.equal(result.token.refresh_token, 'stored-refresh-token');
  assert.equal(result.recordCount, 0);
});
});
