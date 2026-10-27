// No Google tokens are persisted. Each month writes fixed ranges in one shared file.
(() => {
  const excluded = new Set(['geo', 'impressions', 'raw_json', 'engagement_score', 'engagement',
    'month', 'hashtags', 'hashtag', 'language', 'author_verified', 'author_name', 'author_followers', 'bookmarks', 'attachments', 'media']);
  let clientId = '';
  function authorize() {
    if (!clientId) throw new Error('Set GOOGLE_CLIENT_ID in Vercel and redeploy to save months to Google Sheets.');
    if (!window.google?.accounts?.oauth2) throw new Error('Google sign-in has not loaded. Allow accounts.google.com and retry.');
    return new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: clientId, scope: 'https://www.googleapis.com/auth/drive.file', include_granted_scopes: false,
        callback: response => response.error || !response.access_token
          ? reject(new Error('Google authorization was declined. No new X requests were made.')) : resolve(response.access_token),
        error_callback: () => reject(new Error('Google sign-in was closed or blocked. Allow the popup and retry.'))
      });
      client.requestAccessToken();
    });
  }
  async function request(path, token, method, body) {
    const response = await fetch('https://sheets.googleapis.com/v4/spreadsheets' + path, {
      method, headers: {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
      body: JSON.stringify(body), signal: AbortSignal.timeout(45000)
    });
    if (!response.ok) {
      const reasons = {401: 'Google authorization expired. Retry to reconnect and save.',
        403: 'Google denied access. Use the account that owns this collection’s spreadsheet and check Sheets API permissions.',
        429: 'Google’s write limit was reached. Wait a minute, then retry saving.'};
      throw new Error(reasons[response.status] || `Google Sheets returned HTTP ${response.status}. Retry saving.`);
    }
    return response.json();
  }
  async function writeMonth(collection, slot, columns, token, checkpoint, progress) {
    const sheet = collection.sheet;
    const requested = columns.filter(column => !excluded.has(column));
    // Keep active spreadsheets on their original schema so later months cannot shift data.
    const legacy = columns.filter(column => column !== 'engagement' && column !== 'post_type' &&
      (!excluded.has(column) || ['attachments', 'media', 'month', 'hashtags'].includes(column)));
    const selected = sheet.columns || (sheet.id && sheet.headerWritten ? legacy : requested);
    sheet.columns = selected;
    const values = slot.rows.map(row => selected.map(key => String(key === 'collection_title' ? collection.title : key === 'engagement' || excluded.has(key) ? '' : row[key] ?? '')));
    if (values.some(row => row.some(cell => cell.length > 50000))) throw new Error('A cell exceeds Google Sheets’ 50,000-character limit. Your collected posts remain available as CSV.');
    if (!sheet.id) {
      const created = await request('', token, 'POST', {properties: {title: collection.title},
        sheets: [{properties: {sheetId: 0, title: 'Posts', gridProperties: {
          rowCount: 501, columnCount: selected.length, frozenRowCount: 1}}}]});
      if (!/^[A-Za-z0-9_-]+$/.test(created.spreadsheetId || '')) throw new Error('Google returned an invalid spreadsheet ID.');
      sheet.id = created.spreadsheetId;
      await checkpoint();
    }
    async function put(start, rows) {
      const range = encodeURIComponent("'Posts'!A" + start);
      return request('/' + sheet.id + '/values/' + range + '?valueInputOption=RAW', token, 'PUT', {
        majorDimension: 'ROWS', values: rows
      });
    }
    if (!sheet.headerWritten) {
      await put(1, [selected]);
      sheet.headerWritten = true;
      await checkpoint();
    }
    if (slot.sheetStart == null) {
      slot.sheetStart = sheet.nextRow;
      sheet.nextRow += values.length;
      await checkpoint();
    }
    while (slot.uploaded < values.length) {
      const batch = [];
      let bytes = 0;
      for (let i = slot.uploaded; i < values.length && batch.length < 100; i++) {
        const size = new TextEncoder().encode(JSON.stringify(values[i])).length;
        if (batch.length && bytes + size > 1000000) break;
        bytes += size; batch.push(values[i]);
      }
      // Retry exactly the same range when a response is lost; never append duplicates.
      await put(slot.sheetStart + slot.uploaded, batch);
      slot.uploaded += batch.length;
      await checkpoint();
      progress(`Saving ${slot.month}: ${slot.uploaded} of ${values.length} posts`);
      if (slot.uploaded < values.length) await new Promise(resolve => setTimeout(resolve, 1100));
    }
  }
  async function writeTable(title, values, sheet, token, checkpoint, progress) {
    if (!values.length || values.some(row => row.length !== values[0].length || row.some(value => String(value).length > 50000))) throw new Error('The export contains an invalid row or a cell over Google’s 50,000-character limit. Download CSV instead.');
    const properties = {sheetId:0, title:'Replies', gridProperties:{rowCount:Math.max(2, values.length), columnCount:values[0].length, frozenRowCount:1}};
    if (!sheet.id) {
      const created = await request('', token, 'POST', {properties:{title}, sheets:[{properties}]});
      if (!/^[A-Za-z0-9_-]+$/.test(created.spreadsheetId || '')) throw new Error('Google returned an invalid spreadsheet ID.');
      sheet.id = created.spreadsheetId;
      await checkpoint();
    } else {
      await request('/' + sheet.id + ':batchUpdate', token, 'POST', {requests:[{updateSheetProperties:{properties, fields:'gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount'}}]});
    }
    for (let offset=0; offset<values.length;) {
      const batch=[]; let bytes=0;
      while (offset+batch.length<values.length && batch.length<100) {
        const row=values[offset+batch.length]; const size=new TextEncoder().encode(JSON.stringify(row)).length;
        if (batch.length && bytes+size>1000000) break;
        batch.push(row); bytes+=size;
      }
      await request('/' + sheet.id + '/values/' + encodeURIComponent("'Replies'!A" + (offset+1)) + '?valueInputOption=RAW', token, 'PUT', {majorDimension:'ROWS', values:batch});
      offset+=batch.length;
      progress(`Saving replies to Google Drive: ${Math.max(0,offset-1)} of ${values.length-1} rows.`);
      if (offset<values.length) await new Promise(resolve => setTimeout(resolve,1100));
    }
  }
  window.TwittSheets = {setClientId(value) { clientId = value || ''; },
    configured() { return Boolean(clientId); }, authorize, writeMonth, writeTable};
})();
