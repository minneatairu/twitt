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

The title names the spreadsheet and appears in each exported row as `collection_title`; it never changes the X query. Settings lock after starting. The first month creates a Google spreadsheet with one **Posts** tab; later months write the next rows in that same tab, without repeating the header or creating another file. At 500 posts per month, four months produce up to 2,000 rows. Each row includes its month. X's relevance order is retained within each month; no custom score or sorting is applied.

A month turns **green only after its search and all Google writes have succeeded and local progress is saved**. A failed month remains incomplete and blocks the next month. Retry resumes from the last saved X search page or Google batch. If the search finished but the upload failed, retrying does not search X again. Completed searches remain available in the web preview and a combined CSV, even when a Sheets upload fails. The CSV covers completed searches only; the summary separately identifies which months have been saved to Sheets.

The active collection's settings, results, pagination cursors, spreadsheet ID, upload offsets, and month statuses persist in this browser's IndexedDB. Refreshing or reopening in the same browser/profile and origin restores them. Google access tokens are never saved. Other browsers/devices or a different Vercel preview origin do not share this state; clearing site data removes it. Only one active collection is retained locally. **New collection** asks before clearing the local active collection and starts a separate spreadsheet; it does not delete existing Google files. Avoid opening the same active collection in multiple tabs while saving.

The app has no password or application login. Anyone able to access the deployment can run searches using the configured X API allowance.

## Send initial search results to Google Sheets

Each month's **Search & save** button connects to Google and writes to the collection's shared **Posts** tab. **Open Google spreadsheet** always points to this file. Exports retain the same post rows, image URLs, and X result order as the preview/CSV. Sheets omits `geo`, `impressions`, `raw_json`, `engagement_score`, `language`, `author_verified`, `author_name`, `author_followers` (follower count), and `bookmarks`. Likes, reposts, replies, quotes, username, and the remaining fields are retained. CSV keeps its existing columns, plus `collection_title` (the calculated engagement score is absent from all outputs). This workflow does not fetch replies. Older spreadsheets remain unchanged.

One-time Google setup for the deployment owner:

1. In [Google Cloud Console](https://console.cloud.google.com/), create/select a project and enable **Google Sheets API**.
2. Configure the Google Auth Platform consent screen (app name, support email, audience). For an External app in Testing, add each intended Google account as a test user.
3. Create an OAuth client with application type **Web application**. Add your exact deployed origin to **Authorized JavaScript origins**, for example `https://twitt-rose.vercel.app` (no path or trailing slash). Also add `http://localhost:8000` for local use if needed. Open the local app with that exact hostname. Each preview domain needs its own authorized origin; using one stable production domain is easiest. This popup token flow does not use an application redirect endpoint.
4. Add `GOOGLE_CLIENT_ID` in **Vercel → Settings → Environment Variables**, using the public OAuth client ID ending in `.apps.googleusercontent.com`. Redeploy. No client secret, service-account key, or Google API key is needed.
5. Allow popups, click the export button, and approve Google's file permission. If Google blocks access, check the exact JavaScript origin, client ID, enabled Sheets API, consent audience/test users, and any Workspace administrator restrictions. Publishing a consent app beyond test users may require additional Google configuration or review.

Authorization requests only `https://www.googleapis.com/auth/drive.file`, so it can create and edit files you use with this app rather than access every spreadsheet. The Google access token stays in browser memory for that export; it is not stored in localStorage, cookies, the repository, or sent to the Python/X server. The public client ID is intentionally returned to the browser; it is not a secret. The X bearer token remains server-side.

Exports use Google Sheets' `RAW` input mode with string values to preserve long IDs and literal post text. Images are URL fields, not embedded pictures. Writes are batched to fixed ranges: retrying a lost or failed write reuses the same file and range rather than duplicating appended rows. The first spreadsheet has capacity for four 500-post months plus its header. A lost response while creating a file can leave an empty file in Drive. Cells longer than Sheets' 50,000-character limit stop the upload with an explanation; the collected rows remain available as CSV. Keep using the same Google account when resuming a collection.

Live Google authorization and writing require a configured OAuth client and account approval. Automated browser tests use simulated Google/X responses and do not establish live access.

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

CSV columns include post ID/URL/text/time, author ID/name/username/verification/follower count, language, likes/reposts/replies/quotes/bookmarks/impressions when supplied, hashtags, mentions, URLs, conversation/reply references, attachments, geo, image URLs, media metadata/dimensions/alt text, and raw post/author/media JSON. Nested fields are JSON strings; missing fields stay empty. Images are linked, not embedded or downloaded into the CSV. Use the web preview to view them. The UTF-8 BOM supports spreadsheets; formula-like cells are prefixed with an apostrophe. Import long ID columns as text.

Respect X developer terms, retention/deletion obligations, and applicable privacy requirements.

## Validation

```sh
python3 -m unittest discover -s tests -v
node --check static/app.js
node --check static/sheets.js
node --check static/collection-store.js
```

With Playwright/Chromium available and the local app running, run `APP_BASE_URL=http://127.0.0.1:8000 python3 tests/collection_browser.py` for simulated end-to-end checks.

Backend tests use simulated X responses for calendar boundaries, pagination, metadata, preservation of X result order, CSV escaping, same-origin request checks, and stateless search. Browser checks additionally exercise four month slots sharing one spreadsheet, titles separate from X queries, green-only-on-save statuses, upload retry without X refetch, browser reload recovery, excluded Sheets columns, previews, image display, and combined CSV row order. Live API validation requires your token and uses your API allowance. Local verification does not establish a successful Vercel deployment.
