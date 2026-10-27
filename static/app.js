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
      meta.textContent = `${post.created_at} · Type: ${post.post_type || 'unavailable'} · Likes: ${post.likes ?? 'unavailable'} · Reposts: ${post.reposts ?? 'unavailable'} · Replies: ${post.replies ?? 'unavailable'} · Quotes: ${post.quotes ?? 'unavailable'}`;
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
const columns = ['collection_title','month','id','post_type','url','text','created_at','author_id','username','author_name','author_verified','author_followers','language','likes','reposts','replies','quotes','bookmarks','impressions','hashtags','mentions','urls','conversation_id','in_reply_to_user_id','referenced_posts','attachments','images','media','geo','raw_json'];
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
const monthInput = document.querySelector('#month-0');
const searchButton = document.querySelector('#search-month');
const newButton = document.querySelector('#new-collection');
const sheetsStatus = document.querySelector('#sheets-status');
const sheetLink = document.querySelector('#open-sheet');
const current = new Date().toISOString().slice(0, 7);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let collection = null;
let busy = false;
let replyRunning = false;
let initialized = false;
let previousUrl = null;
let previousJsonUrl = null;
monthInput.max = current;
monthInput.value = current;
function hasData() {
  return Boolean(collection && (collection.searchComplete || collection.rows.length || collection.cursor ||
    collection.seenTokens.length || collection.sheet.id));
}
function settingsChanged() {
  return Boolean(collection && (titleInput.value.trim() !== collection.title || queryInput.value.trim() !== collection.query ||
    Number(postLimit.value) !== collection.limit || monthInput.value !== collection.month));
}
function render() {
  const active = busy || replyRunning;
  const changed = settingsChanged();
  [titleInput, queryInput, postLimit, monthInput].forEach(input => { input.disabled = active; });
  submit.hidden = Boolean(collection) && !changed;
  submit.disabled = active || !initialized;
  submit.textContent = changed ? hasData() ? 'Start new collection with these settings' : 'Apply search settings' : 'Start collection';
  newButton.hidden = !collection;
  newButton.disabled = active;
  const reason = !initialized ? 'Loading search settings…' : active ? 'A search or upload is in progress. Please wait.'
    : !monthInput.value ? 'Choose a search month.' : collection?.status === 'saved' && !changed ? 'This search is already saved.' : '';
  searchButton.disabled = Boolean(reason);
  searchButton.title = reason || 'Search this month and save it to a spreadsheet.';
  searchButton.textContent = changed || !collection ? 'Search & save' : collection.status === 'saved' ? '✓ Saved to spreadsheet'
    : collection.searchComplete ? 'Retry save to Sheets' : collection.rows.length ? 'Resume search & save' : 'Search & save';
  const card = document.querySelector('#slot-0');
  card.classList.toggle('saved', collection?.status === 'saved' && !changed);
  card.classList.toggle('failed', collection?.status === 'error' && !changed);
  document.querySelector('#slot-status-0').textContent = changed ? 'Edited settings have not been applied. Search & save starts the updated search.'
    : collection?.status === 'saved' ? `Saved · ${collection.rows.length} posts`
    : collection?.status === 'error' ? collection.error : collection?.status === 'searching' ? `Searching · ${collection.rows.length} posts`
    : collection?.status === 'saving' ? `Saving · ${collection.uploaded} of ${collection.rows.length} posts`
    : reason || 'Ready — click Search & save.';
  document.querySelector('#settings-status').textContent = changed && hasData()
    ? `Your existing results still belong to “${collection.title}” (${collection.month}). Applying edits starts a separate spreadsheet.` : '';
  if (collection?.sheet.id) {
    sheetLink.href = 'https://docs.google.com/spreadsheets/d/' + collection.sheet.id + '/edit'; sheetLink.hidden = false;
  } else { sheetLink.hidden = true; sheetLink.removeAttribute('href'); }
  document.querySelector('#estimate').textContent = `One month · up to ${postLimit.value} posts · one spreadsheet`;
  if (collection && !TwittSheets.configured()) sheetsStatus.textContent = 'Set GOOGLE_CLIENT_ID in Vercel and redeploy before searching and saving.';
  document.dispatchEvent(new CustomEvent('twitt:collection-busy', {detail: busy}));
}
function refreshResults() {
  results = collection?.searchComplete ? collection.rows.map(row => ({...row, collection_title: collection.title})) : [];
  gallery.replaceChildren(); offset = 0;
  document.querySelector('#gallery-section').hidden = results.length === 0;
  if (results.length) showPosts();
  if (collection?.searchComplete) makeDownload(); else download.hidden = true;
  const summary = document.querySelector('#summary'); summary.replaceChildren();
  if (collection) {
    const text = document.createElement('p'); text.className = 'hint';
    text.textContent = `${collection.month} · ${collection.rows.length} posts collected · ${collection.status === 'saved' ? 'Saved to Sheets' : 'Not yet saved to Sheets'}`;
    summary.append(text);
  }
}
async function checkpoint() { await CollectionStore.save(collection); render(); }
function prepareCollection() {
  if (collection && !settingsChanged()) return true;
  if (!form.reportValidity()) return false;
  if (!titleInput.value.trim() || !queryInput.value.trim() || !monthInput.value || monthInput.value < '2006-03' || monthInput.value > current) {
    status.textContent = 'Enter a title, a search query, and one month from March 2006 through the present.';
    return false;
  }
  if (hasData() && !confirm('Start a new single-month collection with these settings? Your existing Google spreadsheet is kept. Download the current CSV first if you need its local results.')) return false;
  collection = {version: 2, title: titleInput.value.trim(), query: queryInput.value.trim(), month: monthInput.value,
    limit: Number(postLimit.value), createdAt: new Date().toISOString(), rows: [], status: 'not_started', searchComplete: false,
    cursor: null, endTime: null, seenTokens: [], uploaded: 0, sheetStart: null, error: '',
    sheet: {id: null, nextRow: 2, headerWritten: false}};
  render(); return true;
}
form.addEventListener('input', render);
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || replyRunning || !initialized || !prepareCollection()) return;
  try {
    await checkpoint(); refreshResults(); status.classList.remove('error');
    status.textContent = `Collection “${collection.title}” ready for ${collection.month}. Click Search & save when ready.`;
  } catch (error) { status.textContent = error.message; status.classList.add('error'); }
});
async function searchMonth() {
  const posts = new Map(collection.rows.map(row => [row.id, row]));
  do {
    const response = await fetch('/api/index', {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({query:collection.query, start:collection.month, end:collection.month,
        candidates:collection.limit, count:Math.max(10, Math.min(100, collection.limit - posts.size)),
        next_token:collection.cursor, end_time:collection.endTime})});
    let page;
    try { page = await response.json(); } catch { throw new Error('X did not return a search page. Retry may use additional allowance.'); }
    if (!response.ok) throw new Error(page.error || 'Search failed.');
    const cursor = page.next_token || null;
    if (!Array.isArray(page.rows) || (cursor && collection.seenTokens.includes(cursor))) throw new Error('Invalid or repeated X pagination response. Search paused.');
    for (const row of page.rows) if (posts.size < collection.limit && !posts.has(row.id)) posts.set(row.id, row);
    collection.rows = [...posts.values()]; collection.cursor = cursor; collection.endTime = page.end_time || collection.endTime;
    if (cursor) collection.seenTokens.push(cursor);
    collection.searchComplete = posts.size >= collection.limit || !cursor;
    status.textContent = `Collected ${posts.size} posts for ${collection.month} in X’s relevance order.`;
    await checkpoint();
    if (!collection.searchComplete) await sleep(1100);
  } while (!collection.searchComplete);
}
searchButton.addEventListener('click', async () => {
  if (busy || replyRunning || searchButton.disabled || !prepareCollection()) return;
  busy = true; render(); status.classList.remove('error');
  try {
    const authorization = TwittSheets.authorize();
    const [token] = await Promise.all([authorization, checkpoint()]);
    if (!collection.searchComplete) {
      collection.status = 'searching'; collection.error = ''; await checkpoint();
      await searchMonth(); collection.status = 'collected'; await checkpoint();
    }
    refreshResults(); collection.status = 'saving'; await checkpoint();
    await TwittSheets.writeMonth(collection, collection, columns, token, checkpoint, message => { sheetsStatus.textContent = message; });
    collection.status = 'saved'; collection.error = ''; await checkpoint(); refreshResults();
    status.textContent = `Saved ${collection.rows.length} posts for ${collection.month}. No custom ranking has been applied.`;
    sheetsStatus.textContent = 'Search saved successfully to the Posts tab.';
  } catch (error) {
    collection.status = 'error'; collection.error = error.message || 'Search or upload failed.';
    status.classList.add('error'); status.textContent = collection.error + (collection.searchComplete ? ' Retry saving without another X search.' : ' Retry resumes from the last saved page.');
    try { await checkpoint(); } catch (storageError) { status.textContent += ' ' + storageError.message; }
    refreshResults();
  } finally { busy = false; render(); }
});
newButton.addEventListener('click', async () => {
  if (busy || replyRunning || !confirm('Start a new collection? This clears the active search’s local results. Google spreadsheets and reply jobs are not deleted.')) return;
  try {
    await CollectionStore.clear(); collection = null;
    if (csvUrl) URL.revokeObjectURL(csvUrl);
    sheetsStatus.textContent = ''; status.classList.remove('error');
    status.textContent = 'Choose the title, query, and month for your new search.';
    render(); refreshResults();
  } catch (error) { status.textContent = error.message; }
});
function showPrevious(previous) {
  if (!previous) return;
  document.querySelector('#previous-collection').hidden = false;
  const rows = previous.slots.filter(slot => slot.searchComplete).flatMap(slot => slot.rows.map(row => ({...row, collection_title: previous.title})));
  const fields = columns.filter(field => !['attachments','media'].includes(field));
  const lines = [fields.map(csvCell).join(','), ...rows.map(row => fields.map(field => csvCell(row[field])).join(','))];
  if (previousUrl) URL.revokeObjectURL(previousUrl);
  previousUrl = URL.createObjectURL(new Blob(['\uFEFF' + lines.join('\r\n') + '\r\n'], {type:'text/csv;charset=utf-8'}));
  const link = document.querySelector('#download-previous'); link.href = previousUrl; link.download = 'previous-collection-posts.csv';
  if (previousJsonUrl) URL.revokeObjectURL(previousJsonUrl);
  previousJsonUrl = URL.createObjectURL(new Blob([JSON.stringify(previous)], {type:'application/json'}));
  const progress = document.querySelector('#download-previous-progress'); progress.href = previousJsonUrl; progress.download = 'previous-collection-progress.json';
  if (previous.sheet?.id) {
    const sheet = document.querySelector('#open-previous'); sheet.href = 'https://docs.google.com/spreadsheets/d/' + previous.sheet.id + '/edit'; sheet.hidden = false;
  }
}
(async () => {
  try {
    const [config, saved, archived] = await Promise.all([
      fetch('/api/index', {signal:AbortSignal.timeout(15000)}).then(response => {
        if (!response.ok) throw new Error('Cannot load server configuration. Refresh to retry.'); return response.json();
      }), CollectionStore.load(), CollectionStore.loadPrevious()]);
    TwittSheets.setClientId(config.google_client_id);
    document.querySelector('#connection').textContent = config.configured ? '● API token configured' : '○ API token needed';
    showPrevious(archived);
    if (saved?.version === 1) {
      const selected = saved.slots.filter(slot => slot.month);
      if (selected.length === 1) {
        const {slots, ...settings} = saved;
        collection = {...settings, ...selected[0], version:2}; await CollectionStore.save(collection);
      } else {
        await CollectionStore.savePrevious(saved); showPrevious(saved);
        titleInput.value = saved.title; queryInput.value = saved.query; postLimit.value = String(saved.limit);
        monthInput.value = selected[0]?.month || current;
        status.textContent = 'Your previous multi-month collection is preserved under Previous multi-month collection. Start a new one-month search when ready.';
      }
    } else if (saved?.version === 2) collection = saved;
    else if (saved) throw new Error('Unsupported saved search format. Existing data was not overwritten.');
    if (collection) {
      titleInput.value = collection.title; queryInput.value = collection.query; postLimit.value = String(collection.limit); monthInput.value = collection.month;
      if (['searching','saving'].includes(collection.status)) { collection.status = 'error'; collection.error = 'Interrupted. Retry to resume.'; }
      refreshResults(); status.textContent = `Restored “${collection.title}” for ${collection.month}.`;
    } else if (!saved && !config.configured) status.textContent = 'Configure X_BEARER_TOKEN in Vercel and redeploy before searching.';
    initialized = true; render();
  } catch (error) { status.textContent = error.message; status.classList.add('error'); }
})();
document.addEventListener('twitt:reply-running', event => { replyRunning = event.detail; render(); });
