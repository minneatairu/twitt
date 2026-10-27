// Reply jobs are independent of initial collections. No API/OAuth credentials are persisted.
(() => {
  const q = id => document.getElementById(id);
  const form = q('reply-import-form');
  const status = q('reply-status');
  const source = q('selected-posts-file');
  const checkpointFile = q('reply-checkpoint-file');
  const start = q('reply-start');
  const end = q('reply-end');
  const run = q('run-replies');
  const pause = q('pause-replies');
  const today = new Date().toISOString().slice(0, 10);
  start.max = end.max = today;
  start.value = '2006-03-21'; end.value = today;
  let state = null;
  let running = false;
  let ready = false;
  let stop = false;
  let initialBusy = false;
  let previewId = null;
  const replyFields = ['id','post_type','url','text','created_at','author_id','username','conversation_id','parent_post_id',
    'likes','reposts','replies','quotes','images'];
  const extraFields = [...replyFields, 'collection_status','collected_count','window_start','window_end'];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const isId = value => typeof value === 'string' && /^[1-9][0-9]{0,24}$/.test(value);
  function normalizeId(value) { return value.trim().replace(/^'/, ''); }

  function parseCSV(text) {
    text = text.replace(/^\uFEFF/, '');
    const records = [];
    let row = [], cell = '', quoted = false, closed = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') { quoted = false; closed = true; }
        else cell += c;
      } else if (c === ',' || c === '\n' || c === '\r') {
        row.push(cell); cell = ''; closed = false;
        if (c !== ',') {
          if (c === '\r' && text[i + 1] === '\n') i++;
          if (row.some(value => value !== '')) records.push(row);
          row = [];
        }
      } else if (c === '"' && !cell && !closed) quoted = true;
      else {
        if (closed || c === '"') throw new Error('Malformed CSV quoting. Export the selected rows as a standard comma-separated CSV.');
        cell += c;
      }
    }
    if (quoted) throw new Error('The CSV contains an unclosed quoted cell.');
    row.push(cell);
    if (row.some(value => value !== '')) records.push(row);
    return records;
  }
  function selectedTable(records) {
    const [headers, ...rows] = records;
    if (!headers?.length || headers.length > 300 || !rows.length || rows.length > 500) throw new Error('Import a CSV with a header and 1–500 selected posts.');
    const names = headers.map(value => value.trim().toLowerCase());
    if (names.some(value => !value) || new Set(names).size !== names.length) throw new Error('CSV column names must be nonempty and unique.');
    const idIndex = names.includes('id') ? names.indexOf('id') : names.indexOf('post_id');
    const conversationIndex = names.indexOf('conversation_id');
    if (idIndex < 0 || conversationIndex < 0) throw new Error('Keep id (or post_id) and conversation_id columns in your selected-posts CSV.');
    const ids = new Set();
    const posts = rows.map((values, index) => {
      if (values.length !== headers.length || values.some(value => typeof value !== 'string')) throw new Error(`CSV row ${index + 2} has a different number of columns or invalid cells.`);
      const id = normalizeId(values[idIndex]);
      const conversationId = normalizeId(values[conversationIndex]);
      if (!isId(id) || !isId(conversationId)) throw new Error(`Row ${index + 2}: IDs must be digit strings, not scientific notation or decimals. Preserve IDs as text in Excel; rounded IDs cannot be repaired.`);
      if (ids.has(id)) throw new Error(`Post ${id} occurs more than once. Keep one row per selected post.`);
      ids.add(id);
      return {id, conversationId, values};
    });
    return {headers, posts};
  }
  function reportedReplies(post, headers) {
    const index = headers.findIndex(value => value.trim().toLowerCase() === 'replies');
    const value = index < 0 ? '' : post.values[index].trim();
    if (!/^\d+$/.test(value)) return null;
    const count = Number(value);
    return Number.isSafeInteger(count) ? count : null;
  }
  function skipped(post, job) {
    return job.skipZeroReplies === true && reportedReplies(post, job.headers) === 0;
  }
  function searchThreads(job) {
    const eligible = new Set(job.posts.filter(post => !skipped(post, job)).map(post => post.conversationId));
    return job.threads.filter(thread => eligible.has(thread.id));
  }
  function workload(job) {
    const counts = job.posts.map(post => reportedReplies(post, job.headers));
    const total = counts.reduce((sum, value) => sum + BigInt(value ?? 0), 0n);
    const zeros = counts.filter(value => value === 0).length;
    const positive = counts.filter(value => value > 0).length;
    const unknown = counts.filter(value => value === null).length;
    const collected = job.threads.reduce((sum, thread) => sum + thread.replies.length, 0);
    const unfinished = job.batches.filter(item => !item.complete).length;
    return `${job.posts.length} posts · ${positive} with reported replies · ${zeros} with zero · ${unknown} with unknown counts. Reported replies total: ${total}${unknown ? ' (known counts only)' : ''}. ` +
      `${job.skipZeroReplies ? zeros : 0} posts skipped because their uploaded reply count is zero. ` +
      `${job.batches.length} search batches · minimum ${unfinished} more API calls · ${job.attempts} calls attempted · ${collected} direct replies collected. ` +
      `Each call requests up to ${job.pageSize} results across a batch. Exact calls are unknown until X finishes pagination; other thread replies and failed attempts can add calls. Counts reflect CSV collection time, not guaranteed accessible English replies in this date window.`;
  }
  function makeThreads(posts) {
    return [...new Set(posts.map(post => post.conversationId))].map(id => ({id, cursor: null, seenTokens: [],
      complete: false, pages: 0, scanned: 0, replies: [], error: null}));
  }
  function batchQuery(ids) {
    const terms = ids.map(id => 'conversation_id:' + id).join(' OR ');
    return (ids.length === 1 ? terms : '(' + terms + ')') + ' is:reply lang:en';
  }
  function batch(ids, progress = {}) {
    return {id: ids.join(','), ids: [...ids], cursor: null, seenTokens: [], complete: false,
      pages: 0, scanned: 0, error: null, ...progress};
  }
  function makeBatches(threads) {
    const batches = [];
    let ids = [];
    for (const thread of threads) {
      if (batchQuery([...ids, thread.id]).length > 1024) { batches.push(batch(ids)); ids = []; }
      ids.push(thread.id);
    }
    if (ids.length) batches.push(batch(ids));
    return batches;
  }
  function mirrorBatchProgress() {
    if (!state?.batches) return;
    const byId = new Map(state.threads.map(thread => [thread.id, thread]));
    for (const item of state.batches) for (const id of item.ids) {
      Object.assign(byId.get(id), {cursor:item.cursor, seenTokens:[...item.seenTokens],
        complete:item.complete, pages:item.pages, error:item.error});
    }
  }
  function windowValid(window) {
    return window && typeof window.start === 'string' && typeof window.end === 'string' &&
      /^\d{4}-\d\d-\d\dT.*Z$/.test(window.start) && /^\d{4}-\d\d-\d\dT.*Z$/.test(window.end) &&
      Date.parse(window.start) >= Date.parse('2006-03-21T00:00:00Z') && Date.parse(window.start) < Date.parse(window.end) && Date.parse(window.end) <= Date.now();
  }
  function validateCheckpoint(input) {
    if (!input || input.kind !== 'twitt-replies' || ![1,2].includes(input.version) || !Array.isArray(input.headers) ||
        !Array.isArray(input.posts) || !Array.isArray(input.threads) || !windowValid(input.window) || ![10,100,500].includes(input.pageSize)) throw new Error('Unsupported or invalid replies checkpoint.');
    const table = selectedTable([input.headers, ...input.posts.map(post => post.values)]);
    if (input.skipZeroReplies !== undefined && typeof input.skipZeroReplies !== 'boolean') throw new Error('Invalid zero-reply policy.');
    if (input.version === 1 && input.skipZeroReplies === true) throw new Error('Legacy checkpoints cannot change their search policy.');
    const policy = {skipZeroReplies: input.skipZeroReplies === true, ...table};
    const expected = makeThreads(table.posts);
    if (expected.length !== input.threads.length) throw new Error('Checkpoint conversations do not match its selected posts.');
    const byId = new Map(table.posts.map(post => [post.id, post]));
    const threads = expected.map((thread, index) => {
      const saved = input.threads[index];
      const token = value => value === null || (typeof value === 'string' && value.length > 0 && value.length <= 4096);
      if (!saved || saved.id !== thread.id || !token(saved.cursor) || !Array.isArray(saved.seenTokens) || saved.seenTokens.length > 100000 ||
          !saved.seenTokens.every(value => typeof value === 'string' && token(value)) || typeof saved.complete !== 'boolean' ||
          (saved.complete && saved.cursor !== null) || !Number.isSafeInteger(saved.pages) || saved.pages < 0 || (saved.complete && saved.pages === 0) ||
          !Number.isSafeInteger(saved.scanned) || saved.scanned < 0 || !Array.isArray(saved.replies) || saved.replies.length > 200000) throw new Error('Invalid conversation progress in checkpoint.');
      const seen = new Set();
      const replies = saved.replies.map(reply => {
        if (!reply || !isId(reply.id) || seen.has(reply.id) || !byId.has(reply.parent_post_id) ||
            byId.get(reply.parent_post_id).conversationId !== thread.id || reply.conversation_id !== thread.id) throw new Error('Invalid or duplicate reply-to-post relationship in checkpoint.');
        seen.add(reply.id);
        return Object.fromEntries(replyFields.map(field => {
          const value = reply[field] ?? '';
          if (!['string','number'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Invalid reply metadata in checkpoint.');
          return [field, value];
        }));
      });
      return {...thread, cursor: saved.cursor, seenTokens: [...saved.seenTokens], complete: saved.complete,
        pages: saved.pages, scanned: saved.scanned, replies,
        error: saved.error && typeof saved.error.code === 'string' ? {code: saved.error.code, message: String(saved.error.message || '')} : null};
    });
    const eligibleThreads = searchThreads({...policy, threads});
    if (threads.some(thread => thread.replies.some(reply => skipped(byId.get(reply.parent_post_id), policy)))) throw new Error('Checkpoint contains replies for skipped posts.');
    let batches;
    if (input.version === 1) {
      // Preserve every started query/cursor exactly; only untouched conversations may be regrouped.
      const started = threads.filter(thread => thread.pages || thread.cursor || thread.complete || thread.replies.length);
      batches = started.map(thread => batch([thread.id], {cursor:thread.cursor, seenTokens:[...thread.seenTokens],
        complete:thread.complete, pages:thread.pages, scanned:thread.scanned, error:thread.error}));
      batches.push(...makeBatches(threads.filter(thread => !started.includes(thread))));
    } else {
      if (!Array.isArray(input.batches) || input.batches.length > eligibleThreads.length) throw new Error('Checkpoint is missing its exact search batches.');
      const claimed = new Set();
      const byConversation = new Map(eligibleThreads.map(thread => [thread.id, thread]));
      batches = input.batches.map(saved => {
        if (!saved || !Array.isArray(saved.ids) || !saved.ids.length || !saved.ids.every(isId) ||
            batchQuery(saved.ids).length > 1024 || new Set(saved.ids).size !== saved.ids.length) throw new Error('Invalid conversation batch in checkpoint.');
        for (const id of saved.ids) {
          const member = byConversation.get(id);
          if (!member || claimed.has(id) || member.cursor !== saved.cursor || member.complete !== saved.complete || member.pages !== saved.pages ||
              JSON.stringify(member.seenTokens) !== JSON.stringify(saved.seenTokens) || member.error?.code !== saved.error?.code) throw new Error('Batch membership or saved pagination progress is inconsistent.');
          claimed.add(id);
        }
        if (!Number.isSafeInteger(saved.scanned) || saved.scanned < 0) throw new Error('Invalid batch page counts.');
        return batch(saved.ids, {cursor:saved.cursor, seenTokens:[...saved.seenTokens], complete:saved.complete,
          pages:saved.pages, scanned:saved.scanned, error:saved.error ? {code:String(saved.error.code), message:String(saved.error.message || '')} : null});
      });
      if (claimed.size !== eligibleThreads.length) throw new Error('Checkpoint batches do not cover every conversation.');
    }
    for (const item of batches) for (const id of item.ids) {
      Object.assign(threads.find(thread => thread.id === id), {cursor:item.cursor, seenTokens:[...item.seenTokens],
        complete:item.complete, pages:item.pages, error:item.error});
    }
    let prefix = 'reply_';
    while (extraFields.some(field => table.headers.some(header => header.toLowerCase() === prefix + field))) prefix = 'collected_' + prefix;
    return {kind: 'twitt-replies', version: 2, id: crypto.randomUUID(), ...table, threads, batches, prefix, skipZeroReplies: policy.skipZeroReplies,
      window: {start: input.window.start, end: input.window.end}, pageSize: input.pageSize,
      attempts: Number.isSafeInteger(input.attempts) && input.attempts >= 0 ? input.attempts : 0,
      retryAt: Number.isFinite(input.retryAt) && input.retryAt > 0 && input.retryAt < Date.now() + 7 * 86400000 ? input.retryAt : null, status: batches.every(thread => thread.complete) ? 'complete' : 'paused',
      message: 'Checkpoint restored. Review progress, then click Start / resume when ready.'};
  }
  async function save() {
    mirrorBatchProgress();
    state.updatedAt = new Date().toISOString();
    await CollectionStore.saveReplies(state);
  }
  function postStatus(post, thread) {
    if (skipped(post, state)) return 'skipped_zero_reported_replies';
    const count = thread.replies.filter(reply => reply.parent_post_id === post.id).length;
    if (thread.complete) return count ? 'complete' : 'complete_no_replies';
    if (thread.error) return count ? 'failed_partial' : 'failed';
    if (!thread.pages) return 'not_searched';
    return state.status.startsWith('paused') ? state.status : 'partial';
  }
  function render() {
    q('reply-controls').hidden = !state;
    run.disabled = !ready || running || initialBusy || !state || state.batches.every(thread => thread.complete);
    pause.disabled = !running;
    q('clear-replies').disabled = running || !ready;
    [source, checkpointFile, q('prepare-replies'), q('reply-budget'), q('reply-auto-resume'), q('skip-zero-replies')].forEach(input => { input.disabled = running || !ready; });
    start.disabled = end.disabled = q('reply-page-size').disabled = running || !ready;
    if (state) q('reply-plan').textContent = workload(state);
    if (state) status.textContent = state.message + `\nFixed UTC window: ${state.window.start} through ${state.window.end} (exclusive end). Page size: ${state.pageSize}.`;
    q('restart-reply-cursor').hidden = !state?.batches.some(thread => !thread.complete && thread.error?.code === 'cursor_invalid');
    q('restart-reply-cursor').disabled = running;
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    for (const label of ['Selected post', 'Reported replies (CSV)', 'Direct replies collected', 'Shared batch pages', 'Status', 'Preview']) {
      const th = document.createElement('th'); th.textContent = label; head.append(th);
    }
    const body = table.createTBody();
    for (const post of state?.posts || []) {
      const thread = state.threads.find(item => item.id === post.conversationId);
      const row = body.insertRow();
      const count = thread.replies.filter(reply => reply.parent_post_id === post.id).length;
      for (const value of [post.id, reportedReplies(post, state.headers) ?? 'unknown', count, thread.pages, postStatus(post, thread)]) row.insertCell().textContent = value;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = 'View';
      button.addEventListener('click', () => { previewId = post.id; preview(); }); row.insertCell().append(button);
    }
    q('reply-summary').replaceChildren(table);
    if (previewId) preview();
  }
  function preview() {
    const container = q('reply-preview'); container.replaceChildren();
    const post = state?.posts.find(item => item.id === previewId);
    if (!post) return;
    const replies = state.threads.find(thread => thread.id === post.conversationId).replies.filter(reply => reply.parent_post_id === post.id);
    const heading = document.createElement('h3'); heading.textContent = `Direct replies to ${post.id} (${replies.length} collected)`; container.append(heading);
    let shown = 0;
    const more = document.createElement('button'); more.type = 'button'; more.className = 'secondary'; more.textContent = 'Show more replies';
    function page() {
      for (const reply of replies.slice(shown, shown + 25)) {
        const article = document.createElement('article'); article.className = 'reply-card';
        const author = document.createElement('a'); author.href = 'https://x.com/i/web/status/' + reply.id; author.target = '_blank'; author.rel = 'noopener noreferrer';
        author.textContent = `${reply.username || reply.author_id} · ${reply.created_at}`;
        const text = document.createElement('p'); text.textContent = reply.text;
        article.append(author, text);
        try {
          const images = JSON.parse(reply.images || '[]');
          for (const image of Array.isArray(images) ? images : []) {
            const url = new URL(image);
            if (url.protocol === 'https:' && url.hostname === 'pbs.twimg.com') {
              const img = document.createElement('img'); img.loading = 'lazy'; img.src = url.href; img.alt = 'Reply image or video preview'; img.referrerPolicy = 'no-referrer'; article.append(img);
            }
          }
        } catch { /* Malformed media metadata does not hide the text. */ }
        container.insertBefore(article, more);
      }
      shown += 25; more.hidden = shown >= replies.length;
    }
    more.addEventListener('click', page); container.append(more); page();
  }
  async function exclusive(action) {
    if (!navigator.locks) throw new Error('This browser does not support safe collection locking. Use a current Chrome, Edge, Firefox, or Safari browser.');
    return navigator.locks.request('twitt-reply-job', {ifAvailable: true}, async lock => {
      if (!lock) throw new Error('Reply collection is active in another tab. Pause or close that tab first.');
      return action();
    });
  }
  function showError(error) { status.textContent = error.message || 'Reply collection failed.'; status.classList.add('error'); }
  source.addEventListener('change', async () => {
    if (running || !source.files[0] || state) return;
    try {
      if (source.files[0].size > 32 * 1024 * 1024) throw new Error('Selected-posts CSV must be at most 32 MiB.');
      const table = selectedTable(parseCSV(await source.files[0].text()));
      const dateColumn = table.headers.map(value => value.toLowerCase()).indexOf('created_at');
      const dates = table.posts.map(post => dateColumn >= 0 ? post.values[dateColumn].slice(0,10) : '').filter(value => /^\d{4}-\d\d-\d\d$/.test(value));
      if (dates.length) start.value = dates.reduce((a,b) => a < b ? a : b);
    } catch (error) { showError(error); }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (running || !ready || !source.files[0]) return;
    try {
      await exclusive(async () => {
        const existing = await CollectionStore.loadReplies();
        if ((state || existing) && !confirm('Replace the local replies job? Download its checkpoint first. Your uploaded CSV and Google spreadsheets are not changed.')) return;
        if (source.files[0].size > 32 * 1024 * 1024) throw new Error('Selected-posts CSV must be at most 32 MiB.');
        const table = selectedTable(parseCSV(await source.files[0].text()));
        const until = new Date(end.value + 'T00:00:00Z'); until.setUTCDate(until.getUTCDate() + 1);
        const window = {start: new Date(start.value + 'T00:00:00Z').toISOString(),
          end: new Date(Math.min(until.getTime(), Date.now() - 30000)).toISOString()};
        if (!windowValid(window)) throw new Error('Choose a valid UTC reply date range ending in the present or past.');
        let prefix = 'reply_';
        while (extraFields.some(field => table.headers.some(header => header.toLowerCase() === prefix + field))) prefix = 'collected_' + prefix;
        const threads = makeThreads(table.posts);
        const skipZeroReplies = q('skip-zero-replies').checked;
        const batches = makeBatches(searchThreads({...table, threads, skipZeroReplies}));
        const next = {kind: 'twitt-replies', version: 2, id: crypto.randomUUID(), ...table,
          threads, batches, prefix, skipZeroReplies, window, pageSize: Number(q('reply-page-size').value), attempts: 0,
          retryAt: null, status: 'ready', message: `Imported ${table.posts.length} selected posts in ${threads.length} conversations, grouped into ${batches.length} search batch(es). No API calls have been made.${batches.length ? '' : ' All posts were explicitly skipped; no searches are needed.'}`};
        await CollectionStore.saveReplies(next); state = next; previewId = null;
        status.classList.remove('error'); render();
      });
    } catch (error) { showError(error); }
  });
  checkpointFile.addEventListener('change', async () => {
    if (running || !ready || !checkpointFile.files[0]) return;
    try {
      await exclusive(async () => {
        if (checkpointFile.files[0].size > 64 * 1024 * 1024) throw new Error('Checkpoint must be at most 64 MiB.');
        const next = validateCheckpoint(JSON.parse(await checkpointFile.files[0].text()));
        const existing = await CollectionStore.loadReplies();
        if ((state || existing) && !confirm('Replace this browser’s active replies job with the imported checkpoint?')) return;
        await CollectionStore.saveReplies(next); state = next; previewId = null;
        start.value = state.window.start.slice(0,10); end.value = new Date(Date.parse(state.window.end) - 1).toISOString().slice(0,10); q('reply-page-size').value = String(state.pageSize); q('skip-zero-replies').checked = state.skipZeroReplies;
        status.classList.remove('error'); render();
      });
    } catch (error) { showError(error); }
    finally { checkpointFile.value = ''; }
  });
  q('clear-replies').addEventListener('click', async () => {
    if (running || !ready || !confirm('Clear the saved replies job and its collected replies from this browser? Download a checkpoint first if you need to keep progress. Original files and Google spreadsheets are unchanged.')) return;
    try {
      await exclusive(async () => {
        await CollectionStore.clearReplies();
        state = null; previewId = null; stop = false;
        source.value = ''; checkpointFile.value = '';
        start.value = '2006-03-21'; end.value = today;
        q('reply-page-size').value = '500'; q('reply-budget').value = '1';
        q('reply-auto-resume').checked = true; q('skip-zero-replies').checked = false;
        q('reply-plan').textContent = ''; q('reply-preview').replaceChildren();
        status.classList.remove('error');
        status.textContent = 'Replies job cleared. Import a CSV to start a new job. No API calls have been made.';
        render();
      });
    } catch (error) { showError(error); }
  });
  pause.addEventListener('click', () => { stop = true; pause.disabled = true; status.textContent = 'Pausing after the current response is saved…'; });
  async function collect() {
    const latest = await CollectionStore.loadReplies();
    if (!latest || latest.id !== state?.id) throw new Error('The reply job changed in another tab. Refresh to load its progress.');
    state = validateCheckpoint(latest); state.id = latest.id; stop = false; running = true;
    document.dispatchEvent(new CustomEvent('twitt:reply-running', {detail: true}));
    const budget = Number(q('reply-budget').value);
    const automatic = q('reply-auto-resume').checked;
    let calls = 0;
    status.classList.remove('error');
    try {
      while (!stop) {
        const thread = state.batches.find(item => !item.complete);
        const members = thread ? state.threads.filter(item => thread.ids.includes(item.id)) : [];
        if (!thread) { state.status = 'complete'; state.message = 'Reply collection complete for the fixed date window: X returned no next page for every search batch.'; break; }
        if (budget && calls >= budget) { state.status = 'paused_budget'; state.message = `Paused after ${calls} API calls this run. Increase the run budget or resume when ready.`; break; }
        if (state.retryAt && Date.now() < state.retryAt) {
          if (!automatic) { state.status = 'paused_rate_limit'; state.message = 'Paused until X’s reset time. Resume when ready.'; break; }
          state.status = 'waiting_rate_limit';
          state.message = `Rate limited. Waiting until ${new Date(state.retryAt).toLocaleString()}. Keep this tab open; Pause stops automatic resumption.`;
          await save(); render();
          while (!stop && Date.now() < state.retryAt) await sleep(1000);
          if (stop) break;
        }
        state.retryAt = null; state.status = 'running'; thread.error = null;
        state.message = `Searching batch of ${thread.ids.length} conversations: ${thread.pages} pages saved. API calls this run: ${calls + 1}${budget ? '/' + budget : ''}.`;
        state.attempts++; calls++;
        await save(); render();
        let response, payload;
        try {
          response = await fetch('/api/index', {method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({action:'replies', conversation_ids:thread.ids, start_time:state.window.start,
              end_time:state.window.end, count:state.pageSize, next_token:thread.cursor}), signal:AbortSignal.timeout(50000)});
          payload = await response.json();
        } catch {
          thread.error = {code:'network_error', message:'Reply request failed or timed out. Cursor retained; retry may use additional allowance.'};
          state.status = 'paused_error'; state.message = thread.error.message; break;
        }
        if (!response.ok) {
          const code = payload.code || 'api_error';
          if (code === 'rate_limited' && Number.isFinite(payload.retry_at) && payload.retry_at * 1000 > Date.now()) {
            state.retryAt = payload.retry_at * 1000; state.status = 'paused_rate_limit';
            state.message = 'X rate limit reached. Cursor and replies retained.';
            await save(); render();
            if (automatic) continue;
          } else {
            thread.error = {code, message:payload.error || `Reply search returned HTTP ${response.status}.`};
            state.status = code === 'usage_limit' ? 'paused_usage_limit' : 'paused_error';
            state.message = thread.error.message + (code === 'usage_limit' ? ' More credits/allowance or a confirmed reset is required; no automatic retries.' : ' The saved cursor has not been reset.');
          }
          break;
        }
        if (!Array.isArray(payload.rows) || (payload.next_token != null && (typeof payload.next_token !== 'string' || !payload.next_token || payload.next_token.length > 4096))) throw new Error('Invalid reply page. Cursor was not advanced.');
        const cursor = payload.next_token || null;
        if (!payload.incomplete && cursor && thread.seenTokens.includes(cursor)) {
          thread.error = {code:'repeated_cursor', message:'X repeated a pagination cursor. Paused without claiming completion.'};
          state.status = 'paused_error'; state.message = thread.error.message; break;
        }
        const selected = new Map(state.posts.filter(post => !skipped(post, state) && thread.ids.includes(post.conversationId)).map(post => [post.id,post]));
        const byConversation = new Map(members.map(item => [item.id,item]));
        const seen = new Set(members.flatMap(item => item.replies.map(reply => reply.id)));
        for (const row of payload.rows) {
          const member = byConversation.get(row.conversation_id);
          const parent = selected.get(row.parent_post_id);
          if (!member || !parent || parent.conversationId !== row.conversation_id || !isId(row.id) || seen.has(row.id)) continue;
          member.replies.push(Object.fromEntries(replyFields.map(field => [field, row[field] ?? '']))); seen.add(row.id);
        }
        if (payload.incomplete) {
          thread.error = {code:'incomplete_page', message:`X returned an incomplete page: ${Number.isSafeInteger(payload.unresolved_count) ? payload.unresolved_count : 'unknown'} returned posts could not be verified. ${payload.warning || ''}`};
          state.status = 'paused_incomplete';
          state.message = `${thread.error.message} Verified replies have been saved (${members.reduce((count,item) => count + item.replies.length,0)} matched replies retained in this batch). The cursor has not advanced and this batch is not complete. Resume retries this page with deduplication and may use additional allowance.`;
          await save(); render(); break;
        }
        thread.pages++; thread.scanned += Number.isSafeInteger(payload.scanned_count) ? payload.scanned_count : payload.rows.length;
        for (const member of members) member.scanned += payload.rows.filter(row => row.conversation_id === member.id).length;
        thread.cursor = cursor; if (cursor) thread.seenTokens.push(cursor);
        thread.complete = !cursor; thread.error = null;
        state.message = `Saved page ${thread.pages} for this batch; ${members.reduce((count,item) => count + item.replies.length,0)} direct replies matched your selected posts.${payload.warning ? ' X metadata warning: ' + payload.warning : ''}`;
        // Persist the data and cursor together before another request can run.
        await save(); render();
        if (!stop) await sleep(1100);
      }
      if (stop) {
        const complete = state.batches.every(thread => thread.complete);
        state.status = complete ? 'complete' : 'paused';
        state.message = complete ? 'Reply collection complete for every search batch in the fixed date window.' : 'Paused by you. Replies and cursor retained; resume when ready.';
      }
      await save();
    } catch (error) {
      state.status = 'paused_error'; state.message = error.message + ' Stopped before another request. Download a checkpoint before closing this tab.';
      try { await save(); } catch { /* Keep the in-memory state downloadable if browser storage is full. */ }
    } finally {
      running = false; document.dispatchEvent(new CustomEvent('twitt:reply-running', {detail:false})); render();
    }
  }
  run.addEventListener('click', async () => {
    if (!state || !ready || running || initialBusy) return;
    try { await exclusive(collect); } catch (error) { showError(error); }
  });
  q('restart-reply-cursor').addEventListener('click', async () => {
    if (running || !state || !confirm('Restart the rejected search batch from its first page? Already collected replies are retained and deduplicated. This uses additional API allowance.')) return;
    try {
      await exclusive(async () => {
        const latest = await CollectionStore.loadReplies();
        if (!latest || latest.id !== state.id) throw new Error('The reply job changed in another tab. Refresh before restarting a cursor.');
        state = validateCheckpoint(latest); state.id = latest.id;
        const thread = state.batches.find(item => !item.complete && item.error?.code === 'cursor_invalid');
        if (!thread) return;
        thread.cursor = null; thread.seenTokens = []; thread.error = null;
        state.retryAt = null; state.status = 'paused'; state.message = 'Cursor restart prepared. Existing replies retained; click Start / resume to search again.';
        await save(); render();
      });
    } catch (error) { showError(error); }
  });
  function download(name, body, type) {
    const url = URL.createObjectURL(new Blob([body], {type}));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  const cell = value => {
    let text = String(value ?? ''); if (/^\s*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"','""') + '"';
  };
  q('download-combined').addEventListener('click', () => {
    if (!state) return;
    const headers = [...state.headers, ...extraFields.map(field => state.prefix + field)];
    const lines = [headers.map(cell).join(',')];
    for (const post of state.posts) {
      const thread = state.threads.find(item => item.id === post.conversationId);
      const replies = thread.replies.filter(reply => reply.parent_post_id === post.id);
      for (const reply of replies.length ? replies : [null]) {
        const values = [...post.values, ...replyFields.map(field => reply?.[field] ?? ''), postStatus(post, thread),
          String(replies.length), state.window.start, state.window.end];
        lines.push(values.map(cell).join(','));
      }
    }
    download('twitt-posts-with-replies.csv', '\uFEFF' + lines.join('\r\n') + '\r\n', 'text/csv;charset=utf-8');
  });
  q('download-reply-checkpoint').addEventListener('click', () => {
    if (state) download('twitt-replies-checkpoint.json', JSON.stringify(state), 'application/json');
  });
  document.addEventListener('twitt:collection-busy', event => { initialBusy = event.detail; render(); });
  (async () => {
    try {
      const saved = await CollectionStore.loadReplies();
      if (saved) {
        // Revalidate persisted files just as imported files; never resume paid calls on load.
        state = validateCheckpoint(saved); state.id = saved.id;
        state.retryAt = Number.isFinite(saved.retryAt) ? saved.retryAt : null;
        start.value = state.window.start.slice(0,10); end.value = new Date(Date.parse(state.window.end) - 1).toISOString().slice(0,10); q('reply-page-size').value = String(state.pageSize); q('skip-zero-replies').checked = state.skipZeroReplies;
        render();
      }
    } catch (error) { showError(error); }
    finally { ready = true; render(); }
  })();
})();
