// No Google tokens are persisted. Each month writes fixed ranges in one shared file.
(() => {
  const excluded = new Set(['referenced_posts', 'in_reply_to_user_id', 'mentions', 'author_id', 'collection_title', 'geo', 'impressions', 'raw_json', 'engagement_score', 'engagement',
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
      ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(45000)
    });
    if (!response.ok) {
      const reasons = {401: 'Google authorization expired. Retry to reconnect and save.',
        403: 'Google denied access. Use the account that owns this collection’s spreadsheet and check Sheets API permissions.',
        429: 'Google’s write limit was reached. Wait a minute, then retry saving.'};
      throw new Error(reasons[response.status] || `Google Sheets returned HTTP ${response.status}. Retry saving.`);
    }
    return response.json();
  }
  async function drive(path, token, method = 'GET', body) {
    const response = await fetch('https://www.googleapis.com/drive/v3/files' + path, {
      method, headers: {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
      ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(45000)
    });
    if (!response.ok) throw new Error(`Google Drive returned HTTP ${response.status}. Check that Drive API is enabled and retry saving to Twitter Research.`);
    return response.json();
  }
  async function organize(sheet, token) {
    // Resolve for the currently authorized account; never reuse another account's folder.
    const query = "name = 'Twitter Research' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and 'me' in owners";
    let pageToken = '', folders = [];
    do {
      const params = new URLSearchParams({q: query, fields: 'nextPageToken,files(id)', pageSize: '1000'});
      if (pageToken) params.set('pageToken', pageToken);
      const page = await drive('?' + params, token);
      folders.push(...(page.files || []));
      pageToken = page.nextPageToken || '';
    } while (pageToken);
    // Choose consistently if the account already contains duplicate named folders.
    folders.sort((a, b) => a.id.localeCompare(b.id));
    const folder = folders[0] || await drive('', token, 'POST', {
      name: 'Twitter Research', mimeType: 'application/vnd.google-apps.folder'
    });
    if (!/^[A-Za-z0-9_-]+$/.test(folder.id || '')) throw new Error('Google returned an invalid folder ID.');
    const file = await drive('/' + sheet.id + '?fields=parents', token);
    if ((file.parents || []).includes(folder.id)) return;
    const params = new URLSearchParams({addParents: folder.id, fields: 'id'});
    if (file.parents?.length) params.set('removeParents', file.parents.join(','));
    await drive('/' + sheet.id + '?' + params, token, 'PATCH', {});
  }
  async function writeMonth(collection, slot, columns, token, checkpoint, progress) {
    const sheet = collection.sheet;
    const requested = columns.filter(column => !excluded.has(column));
    // Keep active spreadsheets on their original schema so later months cannot shift data.
    const legacy = columns.filter(column => column !== 'engagement' && column !== 'post_type' &&
      (!excluded.has(column) || ['referenced_posts', 'in_reply_to_user_id', 'mentions', 'author_id', 'collection_title', 'attachments', 'media', 'month', 'hashtags'].includes(column)));
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
    await organize(sheet, token);
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
    const existing = Boolean(sheet.id);
    if (!sheet.id) {
      const created = await request('', token, 'POST', {properties:{title}, sheets:[{properties}]});
      if (!/^[A-Za-z0-9_-]+$/.test(created.spreadsheetId || '')) throw new Error('Google returned an invalid spreadsheet ID.');
      sheet.id = created.spreadsheetId;
      await checkpoint();
    }
    await organize(sheet, token);
    if (existing) {
      await request('/' + sheet.id + ':batchUpdate', token, 'POST', {requests:[{updateSheetProperties:{properties, fields:'gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount'}}, {updateCells:{range:{sheetId:0}, fields:'userEnteredValue'}}]});
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
  function reportingModel(term, month) {
    // Research sampling labels only; these rules never change an X query.
    const rules = [
      {name:'DALL·E 2', from:'2022-04', through:'2022-07', terms:['#dalle2']},
      {name:'DALL·E 3', from:'2023-10', through:'2024-01', terms:['#dalle3','dall-e 3']},
      {name:'GPT-4o Image Generation', from:'2025-03', through:'2025-06', terms:['4o image generation','chatgpt images','#gptimages','#chatgptimages']},
      {name:'GPT Image 1.5', from:'2025-07', through:'2025-10', terms:['chatgpt images','#gptimages','#chatgptimages']},
      {name:'ChatGPT Images 2.0', from:'2026-04', through:'2026-07', terms:['chatgpt images','#gptimages','#chatgptimages']},
      {name:'ChatGPT Images 2.5', from:'2026-09', through:'2026-09', terms:['chatgpt images','#gptimages','#chatgptimages']}
    ];
    const query = term.normalize('NFKC').toLowerCase().replace(/[“”]/g,'"').replace(/[‐‑–—·]/g,'-')
      .replace(/(^|[\s(])-(?:"[^"]*"|[^\s)]+)/g,'$1 ').replace(/\s+/g,' ');
    const matches = rules.filter(rule => month >= rule.from && month <= rule.through && rule.terms.some(alias => {
      const literal = alias.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      return new RegExp('(?<![\\p{L}\\p{N}_#-])' + literal + '(?![\\p{L}\\p{N}_])','u').test(query);
    }));
    return matches.length === 1 ? matches[0].name : 'Unclassified';
  }
  const reportHeaders = ['Retrieval date and time (UTC)', 'Search Term', 'Search month (UTC start–end)', '# of Initial posts loaded', '# of Replies retrieved', 'Total records (replies + initial posts)', 'Reply search status'];
  async function prepareReporting(token) {
    const query = "name = 'Data Reporting Workbook' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false and 'me' in owners";
    const params = new URLSearchParams({q:query, fields:'files(id)', orderBy:'createdTime', pageSize:'1'});
    const found = await drive('?' + params, token);
    let id = found.files?.[0]?.id;
    if (!id) {
      const created = await request('', token, 'POST', {properties:{title:'Data Reporting Workbook'}, sheets:[{properties:{title:'Logs', gridProperties:{frozenRowCount:1}}}]});
      id = created.spreadsheetId;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(id || '')) throw new Error('Google returned an invalid reporting workbook ID.');
    await organize({id}, token);
    return id;
  }
  async function writeReport(job, token, checkpoint) {
    const report = job.reporting;
    if (!report?.workbookId || !report.term?.trim() || !/^\d{4}-\d{2}$/.test(report.month)) throw new Error('Connect reporting and enter the original search term and month.');
    const id = report.workbookId;
    const metadata = await request('/' + id + '?fields=sheets.properties', token, 'GET');
    let sheets = metadata.sheets.map(sheet => sheet.properties);
    if (!sheets.some(sheet => sheet.title === 'Logs')) {
      const added = await request('/' + id + ':batchUpdate', token, 'POST', {requests:[{addSheet:{properties:{title:'Logs', gridProperties:{frozenRowCount:1}}}}]});
      sheets.push(added.replies[0].addSheet.properties);
    }
    const key = report.key;
    const monthDate = new Date(report.month + '-01T00:00:00Z');
    // Remove the obsolete tab-name column while preserving existing zero counts.
    const header = await request('/' + id + '/values/' + encodeURIComponent("'Logs'!A1:J1"), token, 'GET');
    if (header.values?.[0]?.[8] === 'Result tab') {
      const logSheet = sheets.find(sheet => sheet.title === 'Logs');
      await request('/' + id + ':batchUpdate', token, 'POST', {requests:[{deleteDimension:{range:{sheetId:logSheet.sheetId, dimension:'COLUMNS', startIndex:8, endIndex:9}}}]});
    }
    const last = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth()+1, 0)).toISOString().slice(0,10);
    const replies = new Set(job.threads.flatMap(thread => thread.replies.map(reply => reply.id))).size;
    const replyCountColumn = job.headers.findIndex(header => header.trim().toLowerCase() === 'replies');
    const zeroReplies = job.posts.filter(post => {
      const value = replyCountColumn < 0 ? '' : String(post.values[replyCountColumn] ?? '').trim();
      return /^\d+$/.test(value) && Number(value) === 0;
    }).length;
    const zeroReplyHeader = '# of Initial posts with 0 reported replies';
    const summary = [report.retrievedAt, report.term, `${report.month}-01 – ${last}`, job.posts.length, replies, job.posts.length + replies, job.status];
    const logs = await request('/' + id + '/values/' + encodeURIComponent("'Logs'!A:A"), token, 'GET');
    const rows = logs.values || [];
    const existing = rows.findIndex(row => row[0] === key);
    const row = existing >= 1 ? existing + 1 : Math.max(2,rows.length+1);
    await request('/' + id + '/values/' + encodeURIComponent("'Logs'!A1") + '?valueInputOption=RAW', token, 'PUT', {values:[['Reply job ID',...reportHeaders,zeroReplyHeader,'Model name']]});
    const logPath = existing >= 1 ? encodeURIComponent("'Logs'!A" + row) + '?valueInputOption=RAW' : encodeURIComponent("'Logs'!A:J") + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS';
    await request('/' + id + '/values/' + logPath, token, existing >= 1 ? 'PUT' : 'POST', {values:[[key,...summary,zeroReplies,reportingModel(report.term,report.month)]]});
    report.savedAt = new Date().toISOString();
    await checkpoint();
  }
  window.TwittSheets = {setClientId(value) { clientId = value || ''; },
    configured() { return Boolean(clientId); }, authorize, writeMonth, writeTable, prepareReporting, writeReport};
})();
