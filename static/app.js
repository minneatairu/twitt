const form = document.querySelector('form');
const postLimit = document.querySelector('#post-limit');
const status = document.querySelector('#status');
const submit = document.querySelector('#submit');
const download = document.querySelector('#download');
let results = [];
let csvUrl = null;
let offset = 0;
const gallery = document.querySelector('#gallery');
const more = document.querySelector('#more');
async function showPosts() {
  more.disabled = true;
  try {
    const data = {posts: results.slice(offset, offset + 24), total: results.length};
    for (const post of data.posts) {
      const card = document.createElement('article');
      card.className = 'post';
      const author = document.createElement('a');
      author.href = post.url; author.target = '_blank'; author.rel = 'noopener noreferrer';
      author.textContent = `${post.username ? '@' + post.username : 'Post'} ↗`;
      card.append(author);
      const meta = document.createElement('p'); meta.className = 'hint';
      meta.textContent = `${post.created_at} · Likes: ${post.likes ?? 'unavailable'} · Reposts: ${post.reposts ?? 'unavailable'} · Replies: ${post.replies ?? 'unavailable'} · Quotes: ${post.quotes ?? 'unavailable'}`;
      const text = document.createElement('p'); text.className = 'post-text'; text.textContent = post.text;
      card.append(meta, text);
      const media = JSON.parse(post.media);
      let imageCount = 0;
      for (const item of media) {
        const source = item.type === 'photo' ? item.url : item.preview_image_url;
        if (!source) continue;
        let url;
        try { url = new URL(source); } catch { continue; }
        if (url.protocol !== 'https:' || url.hostname !== 'pbs.twimg.com') continue;
        imageCount++;
        const link = document.createElement('a'); link.href = source; link.target = '_blank'; link.rel = 'noopener noreferrer';
        const img = document.createElement('img'); img.src = source; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
        img.alt = item.alt_text || (item.type === 'photo' ? 'Photo attached to post' : 'Video preview');
        img.addEventListener('error', () => { const fallback = document.createElement('p'); fallback.className = 'hint'; fallback.textContent = 'Image unavailable from X.'; link.replaceWith(fallback); });
        link.append(img); card.append(link);
        if (item.type !== 'photo') { const caption = document.createElement('p'); caption.className = 'hint'; caption.textContent = 'Video preview · open the post to play'; card.append(caption); }
      }
      if (!imageCount) { const note = document.createElement('p'); note.className = 'hint'; note.textContent = 'No attached image returned by X.'; card.append(note); }
      gallery.append(card);
    }
    offset += data.posts.length;
    more.hidden = offset >= data.total;
  } finally { more.disabled = false; }
}
more.addEventListener('click', () => showPosts().catch(error => { status.textContent = error.message; }));
const columns = ['collection_title','month','id','url','text','created_at','author_id','username','author_name','author_verified','author_followers','language','likes','reposts','replies','quotes','engagement','bookmarks','impressions','hashtags','mentions','urls','conversation_id','in_reply_to_user_id','referenced_posts','attachments','images','media','geo','raw_json'];
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
function makeDownload() {
  if (csvUrl) URL.revokeObjectURL(csvUrl);
  const exportColumns = columns.filter(column => !['attachments', 'media'].includes(column));
  const lines = [exportColumns.map(csvCell).join(','), ...results.map(row => exportColumns.map(key => csvCell(row[key])).join(','))];
  csvUrl = URL.createObjectURL(new Blob(['\ufeff' + lines.join('\r\n') + '\r\n'], {type: 'text/csv;charset=utf-8'}));
  download.href = csvUrl;
  download.download = 'twitt-posts.csv';
  download.hidden = false;
}
const titleInput = document.querySelector('#collection-title');
const queryInput = document.querySelector('#query');
const monthInputs = [...document.querySelectorAll('.month-slot input')];
const monthButtons = [...document.querySelectorAll('.month-action')];
const newButton = document.querySelector('#new-collection');
const sheetsStatus = document.querySelector('#sheets-status');
const sheetLink = document.querySelector('#open-sheet');
const current = new Date().toISOString().slice(0, 7);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let collection = null;
let busy = false;
let initialized = false;
monthInputs.forEach(input => { input.max = current; });
monthInputs[0].value = current;

function monthStarted(slot) {
  return slot.searchComplete || slot.rows.length > 0 || Boolean(slot.cursor) || slot.seenTokens.length > 0 ||
    slot.sheetStart != null || slot.uploaded > 0 || slot.status === 'saved';
}
function canEditMonth(index) {
  // Do not insert an earlier month ahead of rows already written to the shared sheet.
  return !collection || !collection.slots.slice(index).some(monthStarted);
}
function identityChanged() {
  return collection && (titleInput.value.trim() !== collection.title || queryInput.value.trim() !== collection.query ||
    Number(postLimit.value) !== collection.limit);
}
function draftRequiresNew() {
  return Boolean(identityChanged() || (collection && monthInputs.some((input, index) =>
    input.value !== collection.slots[index].month && !canEditMonth(index))));
}
function render() {
  const locked = Boolean(collection);
  const changed = draftRequiresNew();
  [titleInput, queryInput, postLimit].forEach(input => { input.disabled = busy; });
  monthInputs.forEach((input, index) => {
    input.disabled = busy || (!changed && !canEditMonth(index));
    input.title = !initialized ? 'Loading collection settings…' : busy ? 'Wait until the current action finishes.'
      : !changed && !canEditMonth(index) ? 'This month or a later month already has collected results. Use an unsearched later slot.'
      : 'Choose or change this month. No search runs until you click Search & save.';
  });
  submit.hidden = locked && !changed;
  submit.textContent = changed ? collection.slots.some(monthStarted) || collection.sheet.id
    ? 'Start new collection with these settings' : 'Apply collection settings' : 'Start collection';
  document.querySelector('#settings-status').textContent = changed
    ? `Edits are not applied yet. Saved results still belong to “${collection.title}”. Use ${submit.textContent} below.`
    : collection ? 'Collection title and query can be edited. Unsearched later months can be changed without starting over.' : '';
  submit.disabled = busy || !initialized;
  newButton.hidden = !locked;
  newButton.disabled = busy;
  const next = collection ? collection.slots.findIndex(slot => slot.month && slot.status !== 'saved')
    : monthInputs.findIndex(input => input.value);
  monthButtons.forEach((button, i) => {
    const slot = collection?.slots[i];
    const card = document.querySelector('#slot-' + i);
    card.classList.toggle('saved', slot?.status === 'saved');
    card.classList.toggle('failed', slot?.status === 'error');
    const month = slot ? slot.month : monthInputs[i].value;
    const reason = !initialized ? 'Loading collection settings…'
      : busy ? 'Another month is searching or saving. Please wait.'
      : changed ? 'Apply the edited collection settings below before searching.'
      : !month ? 'Choose a month for this slot.'
      : slot?.status === 'saved' ? 'This month is already saved.'
      : next !== i ? `Save month slot ${next + 1} first.` : '';
    button.disabled = Boolean(reason);
    button.title = reason || 'Search this month and save it to the collection spreadsheet.';
    button.dataset.disabledReason = reason;
    button.textContent = slot?.status === 'saved' ? '✓ Saved to spreadsheet'
      : slot?.searchComplete ? 'Retry save to Sheets' : slot?.rows.length ? 'Resume search & save' : 'Search & save';
    document.querySelector('#slot-status-' + i).textContent = !slot ? (monthInputs[i].value ? 'Not started' : 'Not selected') : !slot.month ? 'Not selected'
      : slot.status === 'saved' ? `Saved · ${slot.rows.length} posts`
      : slot.status === 'error' ? slot.error
      : slot.status === 'searching' ? `Searching · ${slot.rows.length} posts collected`
      : slot.status === 'saving' ? `Saving · ${slot.uploaded} of ${slot.rows.length} posts`
      : slot.status === 'collected' ? `Collected · ${slot.rows.length} posts · not yet saved`
      : 'Not started';
    const slotStatus = document.querySelector('#slot-status-' + i);
    if (reason && slot?.status !== 'saved' && slot?.status !== 'error') slotStatus.textContent = reason;
    else if (!locked && month) slotStatus.textContent = 'Ready — click Search & save to start the collection.';
  });
  if (collection?.sheet.id) {
    sheetLink.href = 'https://docs.google.com/spreadsheets/d/' + collection.sheet.id + '/edit';
    sheetLink.hidden = false;
  } else { sheetLink.hidden = true; sheetLink.removeAttribute('href'); }
  const months = locked ? collection.slots.filter(slot => slot.month).length : monthInputs.filter(input => input.value).length;
  document.querySelector('#estimate').textContent = `${months} month${months === 1 ? '' : 's'} · up to ${(months * Number(postLimit.value)).toLocaleString()} posts · one spreadsheet`;
  if (locked && !TwittSheets.configured()) sheetsStatus.textContent = 'Set GOOGLE_CLIENT_ID in Vercel and redeploy before searching and saving months.';
}
function refreshResults() {
  results = collection ? collection.slots.filter(slot => slot.searchComplete).flatMap(slot =>
    slot.rows.map(row => ({...row, collection_title: collection.title}))) : [];
  gallery.replaceChildren(); offset = 0;
  document.querySelector('#gallery-section').hidden = results.length === 0;
  if (results.length) showPosts();
  if (collection?.slots.some(slot => slot.searchComplete)) makeDownload();
  else download.hidden = true;
  const table = document.createElement('table');
  const header = table.createTHead().insertRow();
  for (const label of ['Month', 'Collected', 'Saved to Sheets']) {
    const th = document.createElement('th'); th.textContent = label; header.append(th);
  }
  const body = table.createTBody();
  for (const slot of collection?.slots.filter(slot => slot.month) || []) {
    const row = body.insertRow();
    for (const value of [slot.month, slot.rows.length, slot.status === 'saved' ? 'Yes' : 'No']) row.insertCell().textContent = value;
  }
  document.querySelector('#summary').replaceChildren(table);
}
async function checkpoint() {
  await CollectionStore.save(collection);
  render();
}
form.addEventListener('input', render);
monthInputs.forEach((input, index) => input.addEventListener('change', async () => {
  if (!collection || busy || !initialized) return;
  if (draftRequiresNew()) { render(); return; }
  const previous = collection.slots[index];
  if (!canEditMonth(index)) { input.value = previous.month; render(); return; }
  const month = input.value;
  if (month === previous.month) return;
  const proposed = collection.slots.map((slot, i) => i === index ? month : slot.month).filter(Boolean);
  if (proposed.some((value, i) => value < '2006-03' || value > current || (i > 0 && value <= proposed[i - 1]))) {
    input.value = previous.month;
    status.classList.add('error');
    status.textContent = 'Choose distinct months in chronological order, after any already collected month. Future months are unavailable.';
    render();
    return;
  }
  busy = true;
  collection.slots[index] = {...previous, month, status: 'not_started', error: ''};
  render();
  try {
    await checkpoint();
    status.classList.remove('error');
    status.textContent = month ? `Month slot ${index + 1} updated to ${month}. Click Search & save when ready; no API requests have been made.`
      : `Month slot ${index + 1} cleared. You can select it later.`;
    refreshResults();
  } catch (error) {
    collection.slots[index] = previous;
    input.value = previous.month;
    status.classList.add('error'); status.textContent = error.message;
  } finally { busy = false; render(); }
}));
function prepareCollection() {
  if (collection && !draftRequiresNew()) return true;
  if (!form.reportValidity()) return false;
  const months = monthInputs.map(input => input.value);
  const selected = months.filter(Boolean);
  if (!titleInput.value.trim() || !queryInput.value.trim() || !selected.length ||
      selected.some((month, i) => month < '2006-03' || month > current || (i > 0 && month <= selected[i - 1]))) {
    status.textContent = 'Enter a collection title, search query, and one to four distinct months in chronological order.';
    return false;
  }
  if (collection && (collection.slots.some(monthStarted) || collection.sheet.id) &&
      !confirm('Apply these changes as a new collection? The current Google spreadsheet is kept. Local active results will be replaced, so download the CSV first if needed.')) return false;
  collection = {version: 1, title: titleInput.value.trim(), query: queryInput.value.trim(), limit: Number(postLimit.value),
    createdAt: new Date().toISOString(), sheet: {id: null, nextRow: 2, headerWritten: false},
    slots: months.map(month => ({month, rows: [], status: 'not_started', searchComplete: false,
      cursor: null, endTime: null, seenTokens: [], uploaded: 0, sheetStart: null, error: ''}))};
  render();
  return true;
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !initialized || !prepareCollection()) return;
  try {
    await checkpoint();
    refreshResults();
    status.classList.remove('error');
    status.textContent = `Collection “${collection.title}” started. Click Search & save on the first month. All months use one Posts tab.`;
  } catch (error) { collection = null; status.textContent = error.message; render(); }
});
async function searchMonth(slot) {
  const posts = new Map(slot.rows.map(row => [row.id, row]));
  do {
    const response = await fetch('/api/index', {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({query: collection.query, start: slot.month, end: slot.month,
        candidates: collection.limit, count: Math.max(10, Math.min(100, collection.limit - posts.size)),
        next_token: slot.cursor, end_time: slot.endTime})});
    let page;
    try { page = await response.json(); } catch { throw new Error('X search did not return results. Retry may use additional API allowance.'); }
    if (!response.ok) throw new Error(page.error || 'Search request failed.');
    for (const row of page.rows) if (posts.size < collection.limit && !posts.has(row.id)) posts.set(row.id, row);
    const cursor = page.next_token || null;
    if (cursor && slot.seenTokens.includes(cursor)) throw new Error('X repeated a pagination token. Search stopped.');
    slot.rows = [...posts.values()];
    slot.cursor = cursor;
    slot.endTime = page.end_time || slot.endTime;
    if (cursor) slot.seenTokens.push(cursor);
    slot.searchComplete = posts.size >= collection.limit || !cursor;
    status.textContent = `${slot.month}: collected ${posts.size} posts in X’s relevance order.`;
    await checkpoint();
    if (!slot.searchComplete) await sleep(1100);
  } while (!slot.searchComplete);
}
monthButtons.forEach((button, i) => button.addEventListener('click', async () => {
  if (busy || button.disabled || !prepareCollection()) return;
  const slot = collection.slots[i];
  busy = true;
  status.classList.remove('error');
  sheetsStatus.classList.remove('error');
  render();
  try {
    // Request Google authorization immediately from the click, before any awaits or X usage.
    const authorization = TwittSheets.authorize();
    // Open Google's popup from the original click while local state is saved in parallel.
    const [token] = await Promise.all([authorization, checkpoint()]);
    if (!slot.searchComplete) {
      slot.status = 'searching'; slot.error = '';
      await checkpoint();
      await searchMonth(slot);
      slot.status = 'collected';
      await checkpoint();
    }
    refreshResults();
    slot.status = 'saving';
    await checkpoint();
    await TwittSheets.writeMonth(collection, slot, columns, token, checkpoint,
      message => { sheetsStatus.textContent = message; });
    slot.status = 'saved'; slot.error = '';
    await checkpoint();
    refreshResults();
    sheetsStatus.textContent = `Saved ${slot.rows.length} posts for ${slot.month} to the collection’s Posts tab.`;
    const allSaved = collection.slots.filter(item => item.month).every(item => item.status === 'saved');
    status.textContent = allSaved ? `Collection complete: ${results.length} posts saved to one spreadsheet. No custom ranking has been applied.`
      : `${slot.month} saved successfully. Continue with the next month.`;
  } catch (error) {
    slot.status = 'error';
    slot.error = error.name === 'TimeoutError' ? 'Request timed out. Retry to resume.' : error.message;
    status.classList.add('error');
    status.textContent = slot.error + (slot.searchComplete ? ' Collected posts are retained; retry saving without another X search.' : ' Retry resumes from the last saved search page.');
    try { await checkpoint(); } catch (storageError) { status.textContent += ' ' + storageError.message; }
    refreshResults();
  } finally { busy = false; render(); }
}));
newButton.addEventListener('click', async () => {
  if (busy || !confirm('Start a new collection? This clears this browser’s active collection and collected posts. Your Google spreadsheet will not be deleted.')) return;
  try {
    await CollectionStore.clear(); collection = null;
    if (csvUrl) URL.revokeObjectURL(csvUrl);
    sheetsStatus.textContent = '';
    status.classList.remove('error');
    status.textContent = 'Enter the new title, query, and months, then start the collection.';
    render(); refreshResults();
  } catch (error) { status.textContent = error.message; }
});
(async () => {
  try {
    const [config, saved] = await Promise.all([fetch('/api/index', {signal: AbortSignal.timeout(15000)}).then(response => {
      if (!response.ok) throw new Error('Cannot read server configuration. Refresh to retry.');
      return response.json();
    }), CollectionStore.load()]);
    TwittSheets.setClientId(config.google_client_id);
    document.querySelector('#connection').textContent = config.configured ? '● API token configured' : '○ API token needed';
    if (saved) {
      if (saved.version !== 1) throw new Error('This saved collection uses an unsupported format. Export or clear its browser data before continuing.');
      collection = saved;
      titleInput.value = saved.title; queryInput.value = saved.query; postLimit.value = String(saved.limit);
      saved.slots.forEach((slot, i) => {
        monthInputs[i].value = slot.month;
        if (slot.status === 'searching' || slot.status === 'saving') {
          slot.status = 'error'; slot.error = 'Interrupted. Retry to resume.';
        }
      });
      refreshResults();
      status.textContent = `Restored collection “${saved.title}” from this browser. Green months are already saved; continue with the next incomplete month.`;
    } else if (!config.configured) status.textContent = 'Configure X_BEARER_TOKEN in Vercel and redeploy before searching.';
    initialized = true; render();
  } catch (error) { status.textContent = error.message; status.classList.add('error'); }
})();
