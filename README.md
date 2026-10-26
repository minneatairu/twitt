# Twitt

Search English-language X posts by keyword or hashtag in a named collection with up to four month slots, preview up to **500 posts per month** with attached images, and export the same results to Google Sheets or CSV.

## Deploy on Vercel

1. Import this repository into Vercel, or run `npx vercel` from the repository root after authenticating with `npx vercel login`.
2. Use the **Other** framework preset. `vercel.json` explicitly builds `api/index.py` with `@vercel/python` and `static/**` with `@vercel/static`; no frontend build or dependencies are required. Leave the project Root Directory at the repository root and remove any Output Directory override. The configuration routes `/api/index` to the Python function and serves the static home page and assets. Set the function maximum duration to at least 60 seconds in Vercel project settings if your plan supports it; upstream X requests time out after 45 seconds. Python 3.12 is pinned in `.python-version`.
3. Add the **server-side environment variable** to the deployment environments you use:
   - `X_BEARER_TOKEN`: your X API bearer token with full-archive search access.
4. Deploy/redeploy to apply the variables. Open the deployed site, search, inspect the results, and download the CSV.

Do not prefix the token variable with `NEXT_PUBLIC_` or expose it in frontend code. The app sends the X token only from the Python function to `https://api.x.com/2/tweets/search/all`. Vercel environment variables are separate from Codex cloud environment settings. API charges and deployment usage follow your X and Vercel plans. No Vercel project or public deployment is created merely by adding these files.

### How the hosted app works

Each browser request fetches one X page (up to 100 candidates), with the search cursor passed explicitly to the next request. There are no background threads, server database, shared server process state, or server-side jobs. Collection state is stored in IndexedDB in the browser. This works across Vercel function instances and keeps each request bounded. A slow X request can still time out; failures stop collection without automatic retries.

Enter a **Collection title**, a separate X search query, a post limit (5 by default), and up to four distinct months in chronological order. The months need not be consecutive. Click **Search & save** on the first selected month to start directly, then continue month by month. **Start collection** is also available if you want to lock the settings before searching. Later month slots explain which earlier month must be saved before they unlock. Starting a collection itself does not search X. Google authorization happens before searching so declined authorization does not spend X allowance.

The title names the spreadsheet and appears in each exported row as `collection_title`; it never changes the X query. The title, query, and post limit remain editable while idle. Click **Apply collection settings** to update a collection before any results have been collected. Once a collection has results or a spreadsheet, changed settings require **Start new collection with these settings** and confirmation; the prior Google file is kept, and local active results are replaced. Download CSV before replacing local results if you need it. This prevents different search queries from silently mixing into one research dataset. Unsearched later month slots stay editable: choose, change, or clear them whenever no search/upload is running. Months with collected data (and any unused earlier slots ahead of them) stay locked to keep the shared spreadsheet and CSV in the same chronological order. Editing a month saves the choice locally and makes no X or Google requests. The first month creates a Google spreadsheet with one **Posts** tab; later months write the next rows in that same tab, without repeating the header or creating another file. At 500 posts per month, four months produce up to 2,000 rows. Each row includes its month. X's relevance order is retained within each month; no custom score or sorting is applied.

A month turns **green only after its search and all Google writes have succeeded and local progress is saved**. A failed month remains incomplete and blocks the next month. Retry resumes from the last saved X search page or Google batch. If the search finished but the upload failed, retrying does not search X again. Completed searches remain available in the web preview and a combined CSV, even when a Sheets upload fails. The CSV covers completed searches only; the summary separately identifies which months have been saved to Sheets.

The active collection's settings, results, pagination cursors, spreadsheet ID, upload offsets, and month statuses persist in this browser's IndexedDB. Refreshing or reopening in the same browser/profile and origin restores them. Google access tokens are never saved. Other browsers/devices or a different Vercel preview origin do not share this state; clearing site data removes it. Only one active collection is retained locally. **New collection** asks before clearing the local active collection and starts a separate spreadsheet; it does not delete existing Google files. Avoid opening the same active collection in multiple tabs while saving.

The app has no password or application login. Anyone able to access the deployment can run searches using the configured X API allowance.

## Send initial search results to Google Sheets

Each month's **Search & save** button connects to Google and writes to the collection's shared **Posts** tab. **Open Google spreadsheet** always points to this file. Exports retain the same post rows, image URLs, and X result order as the preview/CSV. Sheets omits `geo`, `impressions`, `raw_json`, `engagement_score`, `language`, `author_verified`, `author_name`, `author_followers` (follower count), `bookmarks`, `attachments`, and `media`. Likes, reposts, replies, quotes, username, and the remaining fields are retained. New spreadsheets include an empty `engagement` column immediately after `quotes`, reserved for your later Excel/Sheets calculation. The app leaves it blank and applies no formula. Existing active spreadsheets keep their original column layout when later months are uploaded; add the blank column manually after finishing that collection if needed. CSV retains its other columns and `collection_title`, omitting `attachments` and `media` (the calculated engagement score is absent from all outputs). This workflow does not fetch replies. Older spreadsheets remain unchanged.

One-time Google setup for the deployment owner:

1. In [Google Cloud Console](https://console.cloud.google.com/), create/select a project and enable **Google Sheets API**.
2. Configure the Google Auth Platform consent screen (app name, support email, audience). For an External app in Testing, add each intended Google account as a test user.
3. Create an OAuth client with application type **Web application**. Add your exact deployed origin to **Authorized JavaScript origins**, for example `https://twitt-rose.vercel.app` (no path or trailing slash). Also add `http://localhost:8000` for local use if needed. Open the local app with that exact hostname. Each preview domain needs its own authorized origin; using one stable production domain is easiest. This popup token flow does not use an application redirect endpoint.
4. Add `GOOGLE_CLIENT_ID` in **Vercel → Settings → Environment Variables**, using the public OAuth client ID ending in `.apps.googleusercontent.com`. Redeploy. No client secret, service-account key, or Google API key is needed.
5. Allow popups, click the export button, and approve Google's file permission. If Google blocks access, check the exact JavaScript origin, client ID, enabled Sheets API, consent audience/test users, and any Workspace administrator restrictions. Publishing a consent app beyond test users may require additional Google configuration or review.

Authorization requests only `https://www.googleapis.com/auth/drive.file`, so it can create and edit files you use with this app rather than access every spreadsheet. The Google access token stays in browser memory for that export; it is not stored in localStorage, cookies, the repository, or sent to the Python/X server. The public client ID is intentionally returned to the browser; it is not a secret. The X bearer token remains server-side.

Exports use Google Sheets' `RAW` input mode with string values to preserve long IDs and literal post text. Images are URL fields, not embedded pictures. Writes are batched to fixed ranges: retrying a lost or failed write reuses the same file and range rather than duplicating appended rows. The first spreadsheet has capacity for four 500-post months plus its header. A lost response while creating a file can leave an empty file in Drive. Cells longer than Sheets' 50,000-character limit stop the upload with an explanation; the collected rows remain available as CSV. Keep using the same Google account when resuming a collection.

Live Google authorization and writing require a configured OAuth client and account approval. Automated browser tests use simulated Google/X responses and do not establish live access.

## Resumable replies for the final selected posts

After calculating engagement outside the app and selecting your final posts, export those selected rows as a **UTF-8 comma-separated CSV**. In **Replies for your selected posts**:

1. Upload the CSV (1–500 unique selected posts; at most 32 MiB). Keep `id` (or `post_id`) and `conversation_id`. Import post IDs as **text** in Excel; scientific notation/decimals are rejected, and IDs already rounded by Excel cannot be recovered. All original columns and values, including your own engagement calculation, are retained.
2. Choose the reply start/end dates in UTC and page size (10, 100, or 500 posts requested per X call). The end date is inclusive, capped at 30 seconds before import time if it is today. Click **Import selected posts**. Importing makes no API calls and does not change the uploaded file. Dates/page size are fixed in the job; changing the inputs affects only your next CSV import.
3. Set the request budget: 1, 5 (default), 20 calls, or **Continue until complete or blocked**. Failed calls count toward this local run budget because they may consume allowance. Click **Start / resume replies**. This uses the existing server-side X bearer token, not Google authorization.
4. **Pause after current request** saves the in-flight page and stops before another request. Progress saves after every successful page in browser IndexedDB, independently from the original monthly collection. Initial-search controls and replies controls do not run paid requests simultaneously in the same tab. Web Locks prevent reply jobs from running simultaneously in multiple tabs on the same browser origin.
5. Download **combined CSV** whenever needed, and **checkpoint** before moving devices or clearing site data. A checkpoint is JSON containing selected posts, collected replies, fixed query window/page size, per-conversation cursors, completion flags, and request counts. It contains no API or OAuth credentials, but it does contain your research data. Store it securely. Checkpoint import supports files up to 64 MiB. Restore it in the app to continue; importing/restoring/reloading never starts paid requests automatically.

The app searches `conversation_id:<ID> is:reply lang:en`, with a fixed start/end time and X's `sort_order=recency`. It groups selected posts sharing the same conversation so the thread is fetched once, then retains only replies whose `referenced_tweets` entry of type `replied_to` points **directly to one of your selected post IDs**. This distinguishes replies to the original selected post from replies elsewhere in its thread. Selected posts that are themselves replies are handled by their exact parent relationship. Nonselected replies in those conversations may consume X allowance even though they are not exported. Replies remain English-only, and no engagement formula, custom ranking, or 500-reply total cap is applied.

Each successful page atomically saves its matching replies and the next cursor before another request. Repeated reply IDs retain their first occurrence. A failed response does not advance the cursor. A conversation is complete only after a successful, valid response with no next token; reaching 500 replies or the local request budget is not completion.

### Limits and recovery

- For HTTP 429 with a trustworthy reset/Retry-After time, automatic resumption can wait until that time while the tab remains open. The checkbox can disable automatic resumption. A pause, a closed tab, a suspended browser, or a local request budget can stop the run. Browser timers are not an unattended server worker.
- Credits/usage caps (including HTTP 402 or a 429 without a usable reset) pause for user action. The app does not repeatedly probe them or assume buying credits is authorized.
- Network failures and incomplete pages pause with the last cursor intact. Retrying a request whose response was lost can consume extra allowance, but reply-ID deduplication prevents duplicate output rows.
- A rejected/expired cursor pauses explicitly. **Restart rejected conversation cursor** requires confirmation, keeps the same date window and already-collected replies, and prepares a fresh scan. It does not make requests until Start / resume is clicked. This rescan uses extra allowance and skips duplicate IDs; it is never silent.
- If browser storage fills, collection stops before another request and offers the in-memory checkpoint download. Do not close the tab until you have saved it. Cursor validity, deleted/protected posts, historical coverage, and language detection are controlled by X; a completed search is not a guarantee that every reply ever published is accessible.

### Combined CSV and reply preview

The new CSV contains each original selected-post column followed by prefixed reply fields (`reply_id`, `reply_parent_post_id`, text, author, date, individual metrics, and image URLs) plus collection status, retrieved count, and fixed window. If an original column already uses one of those names, the reply prefix is extended to prevent a collision. Your uploaded file is unchanged, and your own engagement values are copied, not recalculated. Spreadsheet formula-like cells are escaped as literal text, as in the original CSV export.

Each retrieved reply produces one row containing its selected post's original values. A selected post with no retrieved replies still produces one row with empty reply fields. Status distinguishes `not_searched`, `partial`/paused, `failed`/`failed_partial`, `complete`, and `complete_no_replies`. The last means no accessible English direct replies were returned **within the fixed date window**, not that the post has never had replies. The selected-post order is retained; replies retain X's page order. No manual merge is needed. Replies are not automatically written into the original Google spreadsheet.

Use **View** beside a selected post to preview collected replies and images without another X request. Both partial exports and checkpoints are available while paused. A checkpoint restored on another device uses that deployment's configured X token; credentials are never copied into the file.

## Local development

Requires Python 3.12+; no third-party runtime packages or build step.

Configure `X_BEARER_TOKEN` securely in the process environment, then run:

```sh
cd /workspace/twitt
python3 app.py
```

The default bind address is `127.0.0.1`, port `8000`. `HOST` and `PORT` can override it. `.env` files are not loaded automatically. Never commit secrets. `/api/index` reports token presence, without exposing values.

## Search and result order

Use **Posts per month → 10** and fill just one month slot to test with up to 10 posts. Options are 5 (default), 10, 50, 100, and 500. For the smallest test, leave the default at 5. X archive search requires at least 10 results per request, so a five-post collection may fetch 10 from X while displaying/exporting only the first 5. These are live searches and still use your X API allowance; selecting several months applies the limit to each month.

Enter `#solar`, `"clean energy"`, or `(#solar OR #wind) lang:en -is:retweet`. The server groups your query and appends `lang:en` to require English posts, including every OR branch. Only posts X identifies with `lang=en` are returned; language detection is supplied by X. Other search operators are preserved. Select one to four distinct months in chronological order, leaving unused slots empty. Calendar boundaries use UTC; the current month ends at collection time. Future months are rejected.

For each month, the app requests full-archive results with `sort_order=relevancy`, paginating until it reaches your selected limit (up to 500 unique posts) or X has no more matches. Posts retain the order X returns them across pages. The app does not apply its own ranking or reorder posts by engagement. Preview and CSV have the same order, grouped by month from earliest to latest. Engagement metrics are included as metadata and reflect collection time. Deleted and inaccessible posts cannot be collected. Months with fewer matches yield fewer rows.


### Research data processing

- The app sends your query wrapped in parentheses with `lang:en` appended, your UTC month boundaries, and `sort_order=relevancy` to X's full-archive API. This is X's relevance setting, not a custom scoring formula or the personalized X website feed.
- Responses are paginated in the order X provides. Posts not labeled `lang=en` by X are excluded. Duplicate post IDs retain their first occurrence and its metadata. Collection stops at your chosen number of unique English posts per month or when X supplies no next page.
- Months are combined from earliest to latest. Within each month, X's response order is preserved in the preview, CSV, and Google Sheets. No engagement thresholds, custom scoring formulas, calculated engagement-score columns, or engagement-based sorting are applied.
- Likes, reposts, replies, quotes, and other available public metrics are copied individually from X. Their values reflect collection time, not the historical month selected. Unavailable metrics stay empty. `raw_json` preserves the returned post, author, and directly attached media objects for comparison with the flattened columns.
- Column names and nested JSON formatting are normalized for tabular export; `collection_title`, `month`, and a post URL are added. CSV quotes/escapes cells and prefixes formula-like text with an apostrophe for spreadsheet safety. Its unprefixed original remains in `raw_json`. Google Sheets uses RAW string writes to preserve IDs and literal text. These export formats do not reorder rows or calculate metrics.
- English filtering, incomplete API coverage, deleted/inaccessible posts, the per-month limit, and X's relevance algorithm define the collected sample. A collection is not an exhaustive archive of matching posts. Repeating the same query can produce different results as X data, metrics, and relevance results change.

Failures stop collection without retries to avoid unexpected duplicate charges. Retrying starts a new search and can consume additional allowance. A present token alone does not establish valid permissions or credits.

## Images and CSV

The web preview shows directly attached photos and video previews, 24 posts at a time. Images load directly from `pbs.twimg.com`, which must be allowed by any browser/environment network policy. Images from external links and quoted/reposted bodies are not separately expanded. Media can become unavailable if deleted or access changes.

CSV also includes a blank `engagement` column immediately after `quotes`. CSV columns include post ID/URL/text/time, author ID/name/username/verification/follower count, language, likes/reposts/replies/quotes/bookmarks/impressions when supplied, hashtags, mentions, URLs, conversation/reply references, geo, image URLs, and raw post/author/media JSON. Separate `attachments` and `media` columns are omitted from CSV and new Sheets exports. The `images` column retains photo and video-preview URLs; the web preview still uses media metadata internally. Existing active spreadsheet column positions are preserved, with attachment/media cells left blank for later uploads. Nested fields are JSON strings; missing fields stay empty. Images are linked, not embedded or downloaded into the CSV. Use the web preview to view them. The UTF-8 BOM supports spreadsheets; formula-like cells are prefixed with an apostrophe. Import long ID columns as text.

Respect X developer terms, retention/deletion obligations, and applicable privacy requirements.

## Validation

```sh
python3 -m unittest discover -s tests -v
node --check static/app.js
node --check static/sheets.js
node --check static/collection-store.js
node --check static/replies.js
```

With Playwright/Chromium available and the local app running, run `APP_BASE_URL=http://127.0.0.1:8000 python3 tests/collection_browser.py` for simulated collection checks. Run `APP_BASE_URL=http://127.0.0.1:8000 python3 tests/replies_browser.py` for reply checks, including more than 500 replies, request budgets, rate reset waiting, usage caps, checkpoint transfer, invalid cursors, manual pause, and combined CSV output.

Backend tests use simulated X responses for calendar boundaries, pagination, metadata, preservation of X result order, CSV escaping, same-origin request checks, and stateless search. Browser checks additionally exercise four month slots sharing one spreadsheet, titles separate from X queries, green-only-on-save statuses, upload retry without X refetch, browser reload recovery, excluded Sheets columns, previews, image display, and combined CSV row order. Live API validation requires your token and uses your API allowance. Local verification does not establish a successful Vercel deployment.
