const form = document.querySelector('form');
const start = document.querySelector('#start');
const end = document.querySelector('#end');
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
      meta.textContent = `${post.created_at} · ${post.engagement_score} engagements`;
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
const current = new Date().toISOString().slice(0, 7);
start.max = end.max = current;
start.value = end.value = current;
function estimate() {
  const [sy, sm] = start.value.split('-').map(Number);
  const [ey, em] = end.value.split('-').map(Number);
  const months = (ey - sy) * 12 + em - sm + 1;
  document.querySelector('#estimate').textContent = months > 0 && months <= 24
    ? `${months} month${months === 1 ? '' : 's'} · up to ${(months * Number(postLimit.value)).toLocaleString()} exported posts`
    : 'Choose an ordered range of 1–24 months.';
}
form.addEventListener('input', estimate);
estimate();
fetch('/api/index').then(r => r.json()).then(data => {
  TwittSheets.setClientId(data.google_client_id);
  document.querySelector('#connection').textContent = data.configured ? '● API token configured' : '○ API token needed';
  if (!data.configured) status.textContent = 'Configure X_BEARER_TOKEN on the server (Vercel environment variables), then redeploy. Your API token stays on the server.';
}).catch(() => { status.textContent = 'Cannot reach the server. Refresh to retry.'; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const columns = ['month','id','url','text','created_at','author_id','username','author_name','author_verified','author_followers','language','likes','reposts','replies','quotes','bookmarks','impressions','engagement_score','hashtags','mentions','urls','conversation_id','in_reply_to_user_id','referenced_posts','attachments','images','media','geo','raw_json'];
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
function makeDownload() {
  if (csvUrl) URL.revokeObjectURL(csvUrl);
  const lines = [columns.map(csvCell).join(','), ...results.map(row => columns.map(key => csvCell(row[key])).join(','))];
  csvUrl = URL.createObjectURL(new Blob(['\ufeff' + lines.join('\r\n') + '\r\n'], {type: 'text/csv;charset=utf-8'}));
  download.href = csvUrl;
  download.download = 'twitt-posts.csv';
  download.hidden = false;
}
function renderSummary(summary) {
  const table = document.createElement('table');
  const header = table.createTHead().insertRow();
  for (const text of ['Month', 'Candidates', 'Exported']) {
    const th = document.createElement('th'); th.textContent = text; header.append(th);
  }
  const body = table.createTBody();
  for (const month of summary) {
    const row = body.insertRow();
    for (const value of [month.month, month.candidates, month.exported]) row.insertCell().textContent = value;
  }
  document.querySelector('#summary').replaceChildren(table);
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (submit.disabled) return;
  const first = start.value;
  const last = end.value;
  const monthCount = (Number(last.slice(0,4)) - Number(first.slice(0,4))) * 12 + Number(last.slice(5)) - Number(first.slice(5)) + 1;
  if (!Number.isInteger(monthCount) || monthCount < 1 || monthCount > 24 || last > current || first < '2006-03') {
    status.textContent = 'Choose an ordered range of 1–24 months, through the present.';
    return;
  }
  const query = form.query.value;
  const budget = Number(postLimit.value);
  submit.disabled = true;
  download.hidden = true;
  TwittSheets.reset();
  document.querySelector('#gallery-section').hidden = true;
  gallery.replaceChildren();
  results = []; offset = 0;
  status.classList.remove('error');
  document.querySelector('#summary').replaceChildren();
  status.textContent = 'Starting your collection…';
  const summary = [];
  try {
    for (let month = first; month <= last;) {
      const posts = new Map();
      const tokens = new Set();
      let nextToken = null;
      let endTime = null;
      do {
        const response = await fetch('/api/index', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({query, start: month, end: month, candidates: budget, count: Math.max(10, Math.min(100, budget - posts.size)), next_token: nextToken, end_time: endTime})});
        let page;
        try { page = await response.json(); } catch { throw new Error('The server did not return search results. It may have timed out; please try again.'); }
        if (!response.ok) throw new Error(page.error || 'Search request failed.');
        for (const row of page.rows) if (posts.size < budget || posts.has(row.id)) posts.set(row.id, row);
        status.textContent = `${month}: searched ${posts.size.toLocaleString()} candidates`;
        nextToken = page.next_token;
        endTime = page.end_time || endTime;
        if (nextToken && tokens.has(nextToken)) throw new Error('X repeated a pagination token. Collection stopped.');
        tokens.add(nextToken);
        if (nextToken && posts.size < budget) await sleep(1100);
      } while (nextToken && posts.size < budget);
      // Map preserves X's response order across pages; do not rerank by engagement.
      const selected = [...posts.values()].slice(0, budget);
      results.push(...selected);
      summary.push({month, candidates: posts.size, exported: selected.length});
      renderSummary(summary);
      // Completed months can be previewed while subsequent months are collected.
      document.querySelector('#gallery-section').hidden = false;
      if (offset === 0) await showPosts();
      more.hidden = offset >= results.length;
      const date = new Date(month + '-01T00:00:00Z');
      date.setUTCMonth(date.getUTCMonth() + 1);
      month = date.toISOString().slice(0,7);
      if (month <= last) await sleep(1100);
    }
    makeDownload();
    TwittSheets.setResults(results, columns, `Twitt posts · ${query} · ${first} to ${last}`);
    status.textContent = `Collected ${results.length.toLocaleString()} posts. Preview them below, send them to Google Sheets, or download the CSV. Results stay in this tab until you refresh or start a new search.`;
  } catch (error) {
    status.classList.add('error');
    status.textContent = (error.message || 'The request failed.') + ' Collection is incomplete; no complete CSV was generated. Completed months remain visible below. Retrying uses additional API allowance.';
  } finally { submit.disabled = false; }
});

document.addEventListener('twitt:sheets-busy', event => { submit.disabled = event.detail; });
