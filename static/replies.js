// Reply jobs are independent of initial collections. No API/OAuth credentials are persisted.
(() => {
  const q = id => document.getElementById(id);
  const form = q('reply-import-form');
  const status = q('reply-status');
  const source = q('selected-posts-file');
  const start = q('reply-start');
  const end = q('reply-end');
  const run = q('run-replies');
  const pause = q('pause-replies');
  const today = new Date().toISOString().slice(0, 10);
  start.max = end.max = today;
  start.value = '2022-04-01'; end.value = today;
  let state = null;
  let running = false;
  let exporting = false;
  let ready = false;
  let stop = false;
  let initialBusy = false;
  let previewId = null;
  const replyFields = ['id','post_type','url','text','created_at','author_id','username','conversation_id','parent_post_id',
    'likes','reposts','replies','quotes','images'];
  const extraFields = [...replyFields, 'conversation_selected_post_ids', 'collection_status','collected_count','window_start','window_end'];
  const exportFields = ['url','text'];
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
  function sourceName(job) {
    const index = job.headers.findIndex(value => value.trim().toLowerCase() === 'collection_title');
    const fallback = index < 0 ? '' : job.posts[0]?.values[index];
    return (job.sourceFilename || fallback || 'selected-posts').replace(/\.csv$/i, '').replace(/[\/\\\x00-\x1f]/g, '_').slice(0,180);
  }
  function exportTitle(job) { return 'Replies_' + sourceName(job); }
  function exportTable() {
    const headers = [...state.headers, ...exportFields.map(field => state.prefix + field)];
    const names = state.headers.map(header => header.trim().toLowerCase());
    const textColumn = ['text','tweet','tweet_text','post_text','tweet text'].map(name => names.indexOf(name)).find(index => index >= 0);
    const order = headers.map((_, index) => index);
    if (textColumn !== undefined) {
      const replyText = state.headers.length + exportFields.indexOf('text');
      order.splice(order.indexOf(replyText), 1);
      order.splice(textColumn + 1, 0, replyText);
    }
    const visibleOrder = order.filter(index => !['referenced_posts','in_reply_to_user_id','mentions','author_id','collection_title','month','hashtag','hashtags'].includes(headers[index].trim().toLowerCase()));
    const rows = [visibleOrder.map(index => headers[index])];
    const selectedById = new Map(state.posts.map(post => [post.id, post]));
    const seen = new Set();
    for (const thread of state.threads) {
      const selectedPosts = state.posts.filter(post => post.conversationId === thread.id);
      const selectedIds = selectedPosts.map(post => post.id);
      const conversationPost = selectedPosts.find(post => post.id === thread.id) || selectedPosts[0];
      for (const reply of thread.replies) {
        if (seen.has(reply.id)) continue;
        seen.add(reply.id);
        // Prefer the actual selected parent; otherwise repeat a selected tweet
        // from this conversation. Keep the actual parent ID separate and unchanged.
        const parent = selectedById.get(reply.parent_post_id);
        const context = parent?.conversationId === thread.id ? parent.values : conversationPost.values;
        const metadata = {...reply, conversation_selected_post_ids:JSON.stringify(selectedIds)};
        const values = [...context, ...exportFields.map(field => String(metadata[field] ?? ''))];
        rows.push(visibleOrder.map(index => values[index]));
      }
    }
    return rows;
  }
  function repliesFor(post, thread) {
    if (skipped(post, state)) return [];
    return state.scope === 'conversation' ? thread.replies : thread.replies.filter(reply => reply.parent_post_id === post.id);
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
      `${job.batches.length} search batches · minimum ${unfinished} more API calls · ${job.attempts} calls attempted · ${collected} unique replies collected (${job.scope === 'conversation' ? 'whole conversations' : 'legacy direct replies'}). ` +
      `Each call requests up to ${job.pageSize} results across a batch. Exact calls are unknown until X finishes pagination; other thread replies and failed attempts can add calls. CSV counts are direct-reply counts at collection time; whole-conversation results may exceed them. Unknown language is accepted using X’s lang:en search filter. Only conversation membership is required for matching in whole-conversation mode.`;
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
  function validateReporting(input) {
    if (!input) return undefined;
    if (!/^[A-Za-z0-9_-]+$/.test(input.workbookId || '') || !/^[A-Za-z0-9_-]{8,100}$/.test(input.key || '') ||
        typeof input.term !== 'string' || !input.term.trim() || input.term.length > 1024 ||
        !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month || '') || input.month < '2006-03' || input.month > today.slice(0,7)) {
      throw new Error('Invalid reporting metadata in reply job.');
    }
    return {key:input.key, workbookId:input.workbookId, term:input.term, month:input.month,
      tabId:Number.isSafeInteger(input.tabId) && input.tabId >= 0 && input.tabId <= 0x7fffffff ? input.tabId : undefined,
      tab:typeof input.tab === 'string' && /^[A-Za-z0-9 ()]+$/.test(input.tab) && input.tab.length <= 100 ? input.tab : undefined,
      retrievedAt:typeof input.retrievedAt === 'string' && Number.isFinite(Date.parse(input.retrievedAt)) ? input.retrievedAt : undefined};
  }
  function validateJob(input) {
    if (!input || input.kind !== 'twitt-replies' || ![1,2].includes(input.version) || !Array.isArray(input.headers) ||
        !Array.isArray(input.posts) || !Array.isArray(input.threads) || !windowValid(input.window) || ![10,100,500].includes(input.pageSize)) throw new Error('Unsupported or invalid reply job.');
    const table = selectedTable([input.headers, ...input.posts.map(post => post.values)]);
    if (input.skipZeroReplies !== undefined && typeof input.skipZeroReplies !== 'boolean') throw new Error('Invalid zero-reply policy.');
    if (input.version === 1 && input.skipZeroReplies === true) throw new Error('Legacy jobs cannot change their search policy.');
    if (input.scope !== undefined && !['direct','conversation'].includes(input.scope)) throw new Error('Invalid reply scope.');
    const scope = input.scope || 'direct';
    const policy = {skipZeroReplies: input.skipZeroReplies === true, ...table};
    const expected = makeThreads(table.posts);
    if (expected.length !== input.threads.length) throw new Error('Job conversations do not match its selected posts.');
    const byId = new Map(table.posts.map(post => [post.id, post]));
    const threads = expected.map((thread, index) => {
      const saved = input.threads[index];
      const token = value => value === null || (typeof value === 'string' && value.length > 0 && value.length <= 4096);
      if (!saved || saved.id !== thread.id || !token(saved.cursor) || !Array.isArray(saved.seenTokens) || saved.seenTokens.length > 100000 ||
          !saved.seenTokens.every(value => typeof value === 'string' && token(value)) || typeof saved.complete !== 'boolean' ||
          (saved.complete && saved.cursor !== null) || !Number.isSafeInteger(saved.pages) || saved.pages < 0 || (saved.complete && saved.pages === 0) ||
          !Number.isSafeInteger(saved.scanned) || saved.scanned < 0 || !Array.isArray(saved.replies) || saved.replies.length > 200000) throw new Error('Invalid conversation progress in reply job.');
      const seen = new Set();
      const replies = saved.replies.map(reply => {
        if (!reply || !isId(reply.id) || seen.has(reply.id) || reply.conversation_id !== thread.id ||
            (scope === 'direct' ? (!byId.has(reply.parent_post_id) || byId.get(reply.parent_post_id).conversationId !== thread.id) : (reply.parent_post_id !== '' && !isId(reply.parent_post_id)))) throw new Error('Invalid or duplicate reply-to-post relationship in reply job.');
        seen.add(reply.id);
        return Object.fromEntries(replyFields.map(field => {
          const value = reply[field] ?? '';
          if (!['string','number'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Invalid reply metadata in reply job.');
          return [field, value];
        }));
      });
      return {...thread, cursor: saved.cursor, seenTokens: [...saved.seenTokens], complete: saved.complete,
        pages: saved.pages, scanned: saved.scanned, replies,
        error: saved.error && typeof saved.error.code === 'string' ? {code: saved.error.code, message: String(saved.error.message || '')} : null};
    });
    const eligibleThreads = searchThreads({...policy, threads});
    if (scope === 'direct' && threads.some(thread => thread.replies.some(reply => skipped(byId.get(reply.parent_post_id), policy)))) throw new Error('Checkpoint contains replies for skipped posts.');
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
            batchQuery(saved.ids).length > 1024 || new Set(saved.ids).size !== saved.ids.length) throw new Error('Invalid conversation batch in reply job.');
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
      if (claimed.size !== eligibleThreads.length) throw new Error('Job batches do not cover every conversation.');
    }
    for (const item of batches) for (const id of item.ids) {
      Object.assign(threads.find(thread => thread.id === id), {cursor:item.cursor, seenTokens:[...item.seenTokens],
        complete:item.complete, pages:item.pages, error:item.error});
    }
    let prefix = 'reply_';
    while (extraFields.some(field => table.headers.some(header => header.toLowerCase() === prefix + field))) prefix = 'collected_' + prefix;
    return {kind: 'twitt-replies', version: 2, id: crypto.randomUUID(), ...table, threads, batches, prefix, scope, sourceFilename:typeof input.sourceFilename === 'string' ? input.sourceFilename.slice(0,200) : '',
      reporting: validateReporting(input.reporting),
      replySheet:input.replySheet && /^[A-Za-z0-9_-]+$/.test(input.replySheet.id || '') ? {id:input.replySheet.id} : {}, skipZeroReplies: policy.skipZeroReplies,
      window: {start: input.window.start, end: input.window.end}, pageSize: input.pageSize,
      attempts: Number.isSafeInteger(input.attempts) && input.attempts >= 0 ? input.attempts : 0,
      retryAt: Number.isFinite(input.retryAt) && input.retryAt > 0 && input.retryAt < Date.now() + 7 * 86400000 ? input.retryAt : null, status: batches.every(thread => thread.complete) ? 'complete' : 'paused',
      message: 'Reply job loaded. Review progress, then click Start / resume when ready.'};
  }
  async function save() {
    mirrorBatchProgress();
    state.updatedAt = new Date().toISOString();
    await CollectionStore.saveReplies(state);
  }
  function postStatus(post, thread) {
    if (skipped(post, state)) return 'skipped_zero_reported_replies';
    const count = repliesFor(post, thread).length;
    if (thread.complete) return count ? 'complete' : 'complete_no_replies';
    if (thread.error?.code === 'incomplete_page') return 'paused_incomplete';
    if (thread.error) return count ? 'failed_partial' : 'failed';
    if (!thread.pages && !count) return 'not_searched';
    return state.status.startsWith('paused') ? state.status : 'partial';
  }
  function render() {
    renderReporting();
    q('reply-controls').hidden = !state;
    run.disabled = !ready || running || exporting || initialBusy || !state || state.batches.every(thread => thread.complete);
    pause.disabled = !running;
    q('convert-conversation').hidden = !state || state.scope === 'conversation';
    q('convert-conversation').disabled = running || exporting || !ready;
    q('clear-replies').disabled = running || exporting || !ready;
    [source, q('prepare-replies'), q('reply-budget'), q('reply-auto-resume'), q('skip-zero-replies')].forEach(input => { input.disabled = running || exporting || !ready; });
    start.disabled = end.disabled = q('reply-page-size').disabled = running || exporting || !ready;
    if (state) {
      const counts = state.posts.map(post => reportedReplies(post, state.headers));
      const known = counts.filter(count => count !== null);
      const unknown = counts.length - known.length;
      q('reply-loaded-count').textContent = String(state.posts.length);
      q('reply-zero-count').textContent = counts.filter(count => count === 0).length.toLocaleString('en-US');
      q('reply-csv-count').textContent = known.length ? known.reduce((sum,count) => sum + BigInt(count),0n).toLocaleString('en-US') : 'Unavailable';
      q('reply-csv-count-note').textContent = unknown ? `${unknown} of ${counts.length} posts have missing or invalid counts${known.length ? '; total includes known counts only' : '. Keep the replies column in your CSV'}.` : 'Total from the replies column in your CSV';
      const remainingCalls = state.batches.filter(batch => !batch.complete).length;
      q('reply-min-calls').textContent = remainingCalls.toLocaleString('en-US');
      q('reply-min-calls-note').textContent = remainingCalls ? 'At least one call per unfinished batch; additional pages may require more' : 'No unfinished search batches';
      q('reply-plan').textContent = workload(state);
    }
    if (state) status.textContent = state.message + `\nFixed UTC window: ${state.window.start} through ${state.window.end} (exclusive end). Page size: ${state.pageSize}.`;
    q('restart-reply-cursor').hidden = !state?.batches.some(thread => !thread.complete && thread.error?.code === 'cursor_invalid');
    q('restart-reply-cursor').disabled = running || exporting;
    q('save-replies-drive').disabled = running || exporting || !ready || !state;
    q('open-replies-sheet').hidden = !state?.replySheet?.id;
    if (state?.replySheet?.id) q('open-replies-sheet').href = 'https://docs.google.com/spreadsheets/d/' + state.replySheet.id + '/edit';
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    for (const label of ['Selected post', 'Reported replies (CSV)', 'Replies collected (shared conversation)', 'Shared batch pages', 'Status', 'Preview']) {
      const th = document.createElement('th'); th.textContent = label; head.append(th);
    }
    const body = table.createTBody();
    for (const post of state?.posts || []) {
      const thread = state.threads.find(item => item.id === post.conversationId);
      const row = body.insertRow();
      const count = repliesFor(post, thread).length;
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
    const replies = repliesFor(post, state.threads.find(thread => thread.id === post.conversationId));
    const heading = document.createElement('h3'); heading.textContent = `Replies ${state.scope === 'conversation' ? 'in conversation ' + post.conversationId : 'directly to ' + post.id} (${replies.length} collected)`; container.append(heading);
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
  let actionActive = false;
  async function exclusive(action) {
    if (actionActive) throw new Error('An action is already running in this tab. Wait for it to finish.');
    actionActive = true;
    try { return await action(); } finally { actionActive = false; }
  }
  function showError(error) { status.textContent = error.message || 'Reply collection failed.'; status.classList.add('error'); }
  function importMessage(message, error = false) {
    q('reply-import-status').textContent = message;
    q('reply-import-status').classList.toggle('error', error);
  }
  form.addEventListener('invalid', event => {
    const message = event.target === source ? 'Choose your selected-posts CSV first. Keep the id and conversation_id columns.' : 'Choose valid reply start and end dates.';
    importMessage(message, true);
  }, true);
  source.addEventListener('change', async () => {
    if (running || exporting || !source.files[0] || state) return;
    try {
      if (source.files[0].size > 32 * 1024 * 1024) throw new Error('Selected-posts CSV must be at most 32 MiB.');
      selectedTable(parseCSV(await source.files[0].text()));
      importMessage('CSV selected. Click Import selected posts to load it.');
    } catch (error) { importMessage(error.message, true); showError(error); }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (running || exporting || !ready || !source.files[0]) {
      importMessage(!source.files[0] ? 'Choose your selected-posts CSV first.' : 'Wait for the current operation to finish, then import again.', true);
      return;
    }
    importMessage('Reading and validating your CSV…');
    try {
      await exclusive(async () => {
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
          threads, batches, prefix, scope:'conversation', sourceFilename:source.files[0].name, replySheet:{}, skipZeroReplies, window, pageSize: Number(q('reply-page-size').value), attempts: 0,
          retryAt: null, status: 'ready', message: `Imported ${table.posts.length} selected posts in ${threads.length} conversations, grouped into ${batches.length} search batch(es). No API calls have been made.${batches.length ? '' : ' All posts were explicitly skipped; no searches are needed.'}`};
        await CollectionStore.saveReplies(next); state = next; previewId = null;
        const active = await CollectionStore.load();
        const activeIds = new Set((active?.rows || []).map(row => row.id));
        const matches = table.posts.every(post => activeIds.has(post.id));
        q('report-term').value = matches ? active?.query || '' : '';
        q('report-month').value = matches ? active?.month || '' : '';
        reportStatus.textContent = reportingToken ? 'Reporting connected this session. Enter the original search term and month; the next run will log automatically.' : 'Optional reporting is not connected. You can start replies without it.';
        importMessage(`Loaded ${table.posts.length} selected posts. Use Start / resume replies below. No X requests have been made.`);
        status.classList.remove('error'); render();
        q('reply-controls').scrollIntoView({behavior:'smooth', block:'center'});
      });
    } catch (error) { importMessage(error.message, true); showError(error); }
  });
  q('convert-conversation').addEventListener('click', async () => {
    if (running || exporting || !ready || !state || !confirm('Switch to all replies in each selected conversation? Existing replies are retained. Previously started batches must be searched again from their first page to recover nested replies discarded by the old mode. This prepares the job without API calls; Start / resume uses additional allowance. Export your results first if you need the original job.')) return;
    try {
      await exclusive(async () => {
        const latest = await CollectionStore.loadReplies();
        if (!latest || latest.id !== state.id) throw new Error('The current session job changed. Retry this action.');
        state = validateJob(latest); state.id = latest.id;
        state.scope = 'conversation'; state.retryAt = null;
        state.batches = state.batches.map(item => batch(item.ids));
        for (const thread of state.threads) Object.assign(thread, {cursor:null, seenTokens:[], complete:false, pages:0, scanned:0, error:null});
        state.status = 'ready';
        state.message = 'Whole-conversation collection prepared. Saved replies retained and will be deduplicated. Pagination reset to recover previously discarded nested replies. No API calls made by this change; click Start / resume when ready.';
        await save(); render();
      });
    } catch (error) { showError(error); }
  });
  q('clear-replies').addEventListener('click', async () => {
    if (running || exporting || !ready) return;
    try {
      await exclusive(async () => {
        await CollectionStore.clearReplies();
        state = null; previewId = null; stop = false;
        source.value = '';
        start.value = '2022-04-01'; end.value = today;
        q('reply-page-size').value = '500'; q('reply-budget').value = '1';
        q('reply-auto-resume').checked = true; q('skip-zero-replies').checked = false;
        q('reply-plan').textContent = ''; q('reply-preview').replaceChildren();
        status.classList.remove('error');
        status.textContent = 'Current replies cleared. Import a CSV to start a new job. No API calls have been made.';
        render();
      });
    } catch (error) { showError(error); }
  });
  pause.addEventListener('click', () => { stop = true; pause.disabled = true; status.textContent = 'Pausing after the current response is saved…'; });
  async function collect() {
    const latest = await CollectionStore.loadReplies();
    if (!latest || latest.id !== state?.id) throw new Error('The current session job changed. Choose the file you want to use.');
    state = validateJob(latest); state.id = latest.id; stop = false; running = true;
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
            body: JSON.stringify({action:'replies', scope:state.scope, conversation_ids:thread.ids, start_time:state.window.start,
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
          if (!member || (state.scope !== 'conversation' && (!parent || parent.conversationId !== row.conversation_id)) || !isId(row.id) || seen.has(row.id)) continue;
          member.replies.push(Object.fromEntries(replyFields.map(field => [field, row[field] ?? '']))); seen.add(row.id);
        }
        if (payload.incomplete) {
          thread.error = {code:'incomplete_page', message:`X returned an incomplete page: ${Number.isSafeInteger(payload.unresolved_count) ? payload.unresolved_count : 'unknown'} returned posts could not be verified. ${payload.warning || ''}`};
          state.status = 'paused_incomplete';
          state.message = `${thread.error.message} Verified replies have been saved (${members.reduce((count,item) => count + item.replies.length,0)} replies retained in this batch). The cursor has not advanced and this batch is not complete. Resume retries this page with deduplication and may use additional allowance.`;
          await save(); render(); break;
        }
        thread.pages++; thread.scanned += Number.isSafeInteger(payload.scanned_count) ? payload.scanned_count : payload.rows.length;
        for (const member of members) member.scanned += payload.rows.filter(row => row.conversation_id === member.id).length;
        thread.cursor = cursor; if (cursor) thread.seenTokens.push(cursor);
        thread.complete = !cursor; thread.error = null;
        state.message = `Saved page ${thread.pages} for this batch; ${members.reduce((count,item) => count + item.replies.length,0)} replies matched the selected conversations.${payload.warning ? ' X metadata warning: ' + payload.warning : ''}`;
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
      state.status = 'paused_error'; state.message = error.message + ' Stopped before another request. Export your results before refreshing or closing this tab.';
      try { await save(); } catch { /* Keep the in-memory state downloadable if browser storage is full. */ }
    } finally {
      if (calls > 0 && state.reporting) {
        state.reporting.retrievedAt = new Date().toISOString();
        try { await save(); await syncReport(); }
        catch (error) { reportStatus.textContent = 'Report not saved: ' + error.message; }
      }
      running = false; document.dispatchEvent(new CustomEvent('twitt:reply-running', {detail:false})); render();
    }
  }
  run.addEventListener('click', async () => {
    if (!state || !ready || running || exporting || initialBusy) return;
    try {
      await exclusive(async () => {
        if (!state.reporting && reportingToken && reportingWorkbookId) {
          const term = q('report-term').value.trim(), month = q('report-month').value;
          if (!term || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < '2006-03' || month > today.slice(0,7)) throw new Error('Enter the original search term and month for automatic reporting before starting replies.');
          state.reporting = {key:crypto.randomUUID(), workbookId:reportingWorkbookId, term, month};
          await save();
        }
        await collect();
      });
    } catch (error) { showError(error); }
  });
  q('restart-reply-cursor').addEventListener('click', async () => {
    if (running || exporting || !state || !confirm('Restart the rejected search batch from its first page? Already collected replies are retained and deduplicated. This uses additional API allowance.')) return;
    try {
      await exclusive(async () => {
        const latest = await CollectionStore.loadReplies();
        if (!latest || latest.id !== state.id) throw new Error('The current session job changed. Retry this action.');
        state = validateJob(latest); state.id = latest.id;
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
    const lines = exportTable().map(row => row.map(cell).join(','));
    download(exportTitle(state) + '.csv', '\uFEFF' + lines.join('\r\n') + '\r\n', 'text/csv;charset=utf-8');
  });
  q('save-replies-drive').addEventListener('click', async () => {
    if (!state || !ready || running || exporting || initialBusy) return;
    exporting = true; render();
    try {
      // Start authorization synchronously from the click so browsers permit its popup.
      const authorization = TwittSheets.authorize();
      const token = await authorization;
      await exclusive(async () => {
        const latest = await CollectionStore.loadReplies();
        if (!latest || latest.id !== state.id) throw new Error('The current session job changed. Retry saving.');
        state = validateJob(latest); state.id = latest.id;
        state.replySheet ||= {};
        await TwittSheets.writeTable(exportTitle(state), exportTable(), state.replySheet, token, save, message => { status.textContent = message; });
        await save();
        state.message = `Saved ${exportTitle(state)} to Google Drive as a Google spreadsheet. No X API calls were made. Saving again updates this same spreadsheet.`;
        await save(); status.classList.remove('error');
      });
    } catch (error) { if (state) state.message = error.message; showError(error); }
    finally { exporting = false; render(); }
  });
  q('download-reply-checkpoint').addEventListener('click', () => {
    if (state) download('twitt-replies-checkpoint.json', JSON.stringify(state), 'application/json');
  });
  let reportingToken = null;
  let reportingWorkbookId = null;
  const reportStatus = q('report-status');
  function renderReporting() {
    q('reporting-options').hidden = !state;
    const busy = running || exporting || initialBusy;
    q('connect-reporting').disabled = busy || !state;
    q('retry-reporting').disabled = busy || !state?.reporting?.retrievedAt;
    q('retry-reporting').hidden = !state?.reporting?.retrievedAt;
    q('report-term').disabled = q('report-month').disabled = busy || Boolean(state?.reporting);
    q('open-reporting').hidden = !state?.reporting?.workbookId;
    if (state?.reporting) {
      q('report-term').value = state.reporting.term;
      q('report-month').value = state.reporting.month;
      q('open-reporting').href = 'https://docs.google.com/spreadsheets/d/' + state.reporting.workbookId + '/edit';
    }
  }
  async function syncReport() {
    if (!state?.reporting?.retrievedAt) return;
    try {
      if (!reportingToken) throw new Error('Reconnect automatic reporting to upload this job’s report.');
      reportStatus.textContent = 'Updating Data Reporting Workbook…';
      await TwittSheets.writeReport(state, exportTable(), reportingToken, save);
      reportStatus.textContent = `Report saved in ${state.reporting.tab}. Counts include all replies collected so far; status: ${state.status}.`;
      reportStatus.classList.remove('error');
    } catch (error) {
      reportStatus.textContent = `Report not saved: ${error.message} Your replies are retained. Reconnect or retry the report upload; no X requests are repeated.`;
      reportStatus.classList.add('error');
    }
  }
  q('connect-reporting').addEventListener('click', async () => {
    if (!state || running || exporting || initialBusy) return;
    const term = state.reporting?.term || q('report-term').value.trim();
    const month = state.reporting?.month || q('report-month').value;
    if (!term || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < '2006-03' || month > today.slice(0,7)) {
      reportStatus.textContent = 'Enter the original search term and a valid search month before connecting.'; return;
    }
    exporting = true; render();
    try {
      // Authorize directly from the click, before any asynchronous work.
      reportingToken = await TwittSheets.authorize();
      await exclusive(async () => {
        const workbookId = await TwittSheets.prepareReporting(reportingToken);
        if (state.reporting && state.reporting.workbookId !== workbookId) throw new Error('Reconnect with the Google account that owns this job’s reporting workbook.');
        reportingWorkbookId = workbookId;
        state.reporting ||= {key:crypto.randomUUID(), workbookId, term, month};
        await save();
        reportStatus.textContent = 'Automatic reporting connected. Reply-search runs will update this workbook, including partial runs.';
        reportStatus.classList.remove('error');
        if (state.reporting.retrievedAt) await syncReport();
      });
    } catch (error) { reportStatus.textContent = error.message; reportStatus.classList.add('error'); }
    finally { exporting = false; render(); }
  });
  q('retry-reporting').addEventListener('click', async () => {
    if (!state || running || exporting || initialBusy) return;
    exporting = true; render();
    try { await exclusive(syncReport); }
    catch (error) { reportStatus.textContent = error.message; }
    finally { exporting = false; render(); }
  });
  document.addEventListener('twitt:collection-busy', event => { initialBusy = event.detail; render(); });
  ready = true; render();
})();
