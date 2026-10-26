// Google authorization and export run in the browser; no Google tokens are persisted.
(() => {
  const button = document.querySelector('#send-sheets');
  const message = document.querySelector('#sheets-status');
  const link = document.querySelector('#open-sheet');
  const scope = 'https://www.googleapis.com/auth/drive.file';
  const excludedColumns = new Set(['geo', 'impressions', 'raw_json', 'engagement_score',
    'language', 'author_verified', 'author_name', 'author_followers']);
  let clientId = '';
  let dataset = null;
  let state = null;
  let busy = false;

  function update() {
    button.hidden = !dataset;
    button.disabled = busy || !clientId || Boolean(state?.done);
    if (dataset && !clientId) {
      message.textContent = 'To enable Sheets export, set GOOGLE_CLIENT_ID in Vercel and redeploy.';
    }
  }

  function authorize() {
    if (!window.google?.accounts?.oauth2) {
      throw new Error('Google sign-in has not loaded. Allow accounts.google.com, then retry.');
    }
    return new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope,
        include_granted_scopes: false,
        callback: response => {
          if (response.error || !response.access_token) {
            reject(new Error('Google authorization was declined or failed. Your search results are still available.'));
          } else resolve(response.access_token);
        },
        error_callback: () => reject(new Error('Google sign-in was closed or blocked. Allow the popup, then retry.'))
      });
      client.requestAccessToken();
    });
  }

  async function googleRequest(path, token, method, body) {
    const response = await fetch('https://sheets.googleapis.com/v4/spreadsheets' + path, {
      method,
      headers: {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000)
    });
    if (!response.ok) {
      const reasons = {401: 'Google authorization expired. Click again to reconnect and resume.',
        403: 'Google denied access. Enable the Google Sheets API and allow the requested file permission.',
        429: 'Google’s write limit was reached. Wait a minute, then click again to resume.'};
      throw new Error(reasons[response.status] || `Google Sheets returned HTTP ${response.status}. Click again to retry.`);
    }
    return response.json();
  }

  button.addEventListener('click', async () => {
    if (!dataset || busy || state?.done) return;
    busy = true;
    update();
    document.dispatchEvent(new CustomEvent('twitt:sheets-busy', {detail: true}));
    message.classList.remove('error');
    try {
      if (!state) {
        const values = [dataset.columns, ...dataset.rows.map(row => dataset.columns.map(key => String(row[key] ?? '')))];
        if (values.some(row => row.some(cell => cell.length > 50000))) {
          throw new Error('A metadata cell exceeds Google Sheets’ 50,000-character limit. Use CSV for this collection.');
        }
        state = {values, next: 0, spreadsheetId: null, done: false};
      }
      message.textContent = 'Connect your Google account to create a spreadsheet…';
      // Call authorization directly from the click handler, before any network awaits.
      const token = await authorize();
      if (!state.spreadsheetId) {
        const spreadsheet = await googleRequest('', token, 'POST', {
          properties: {title: dataset.title},
          sheets: [{properties: {sheetId: 0, title: 'Posts', gridProperties: {
            rowCount: Math.max(1000, state.values.length), columnCount: dataset.columns.length,
            frozenRowCount: 1
          }}}]
        });
        if (!/^[A-Za-z0-9_-]+$/.test(spreadsheet.spreadsheetId || '')) throw new Error('Google returned an invalid spreadsheet ID.');
        state.spreadsheetId = spreadsheet.spreadsheetId;
        link.href = 'https://docs.google.com/spreadsheets/d/' + state.spreadsheetId + '/edit';
        link.hidden = false;
      }
      while (state.next < state.values.length) {
        const batch = [];
        let bytes = 0;
        for (let i = state.next; i < state.values.length && batch.length < 100; i++) {
          const rowBytes = new TextEncoder().encode(JSON.stringify(state.values[i])).length;
          if (batch.length && bytes + rowBytes > 1000000) break;
          bytes += rowBytes;
          batch.push(state.values[i]);
        }
        const range = encodeURIComponent("'Posts'!A" + (state.next + 1));
        // Fixed ranges make retries idempotent even if a response was lost after writing.
        await googleRequest('/' + state.spreadsheetId + '/values/' + range + '?valueInputOption=RAW', token, 'PUT', {
          majorDimension: 'ROWS', values: batch
        });
        state.next += batch.length;
        message.textContent = `Sent ${Math.min(dataset.rows.length, state.next - 1).toLocaleString()} of ${dataset.rows.length.toLocaleString()} posts…`;
        if (state.next < state.values.length) await new Promise(resolve => setTimeout(resolve, 1100));
      }
      state.done = true;
      button.textContent = 'Sent to Google Sheets';
      message.textContent = `Saved ${dataset.rows.length.toLocaleString()} posts to the Posts tab. No additional X searches were made.`;
    } catch (error) {
      message.classList.add('error');
      message.textContent = (error.name === 'TimeoutError' ? 'The Google request timed out. Click again to retry.' : error.message || 'Sheets export failed.')
        + (state?.spreadsheetId ? ' The spreadsheet may be incomplete; retry resumes the same file.' : '');
      button.textContent = state?.spreadsheetId ? 'Resume Google Sheets export' : 'Send to Google Sheets';
    } finally {
      busy = false;
      update();
      document.dispatchEvent(new CustomEvent('twitt:sheets-busy', {detail: false}));
    }
  });

  window.TwittSheets = {
    setClientId(value) { clientId = value || ''; update(); },
    setResults(rows, columns, title) {
      dataset = {rows: [...rows], columns: columns.filter(column => !excludedColumns.has(column)),
        title: title.slice(0, 200)};
      state = null;
      button.textContent = 'Send to Google Sheets';
      message.textContent = 'Creates a new spreadsheet in your Google account from these results.';
      update();
    },
    reset() {
      dataset = null; state = null;
      message.textContent = ''; link.hidden = true; link.removeAttribute('href');
      update();
    }
  };
})();
