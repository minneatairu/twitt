# Twitt

Search English-language X posts by keyword or hashtag across a selectable month range, preview up to **500 posts per month** with attached images, and export the same results to Google Sheets or CSV.

## Deploy on Vercel

1. Import this repository into Vercel, or run `npx vercel` from the repository root after authenticating with `npx vercel login`.
2. Use the **Other** framework preset. `vercel.json` explicitly builds `api/index.py` with `@vercel/python` and `static/**` with `@vercel/static`; no frontend build or dependencies are required. Leave the project Root Directory at the repository root and remove any Output Directory override. The configuration routes `/api/index` to the Python function and serves the static home page and assets. Set the function maximum duration to at least 60 seconds in Vercel project settings if your plan supports it; upstream X requests time out after 45 seconds. Python 3.12 is pinned in `.python-version`.
3. Add the **server-side environment variable** to the deployment environments you use:
   - `X_BEARER_TOKEN`: your X API bearer token with full-archive search access.
4. Deploy/redeploy to apply the variables. Open the deployed site, search, inspect the results, and download the CSV.

Do not prefix the token variable with `NEXT_PUBLIC_` or expose it in frontend code. The app sends the X token only from the Python function to `https://api.x.com/2/tweets/search/all`. Vercel environment variables are separate from Codex cloud environment settings. API charges and deployment usage follow your X and Vercel plans. No Vercel project or public deployment is created merely by adding these files.

### How the hosted app works

Each browser request fetches one X page (up to 100 candidates), with the search cursor passed explicitly to the next request. There are no background threads, database, shared process state, or durable jobs. This works across Vercel function instances and keeps each request bounded. A slow X request can still time out; failures stop collection without automatic retries.

The browser collects results per month in X’s response order, renders a paginated preview of text, author, date, engagement, images, and video previews, then generates the CSV locally. Completed months become visible while later months are still collecting. A failed collection does not generate a complete CSV. Earlier completed months remain visible. Keep the tab open during collection. Results disappear on refresh, closing the tab, or starting another search; download the CSV to keep them. There is no saved-results history or shareable dataset URL.

The app has no password or application login. Anyone able to access the deployment can run searches using the configured X API allowance.

## Send initial search results to Google Sheets

After a complete initial search, click **Send to Google Sheets**, choose your Google account, and allow the app to create a spreadsheet. It creates a new file with a **Posts** tab containing the same rows, columns, image URLs, and X result order as the preview/CSV. It does not fetch replies or make any more X requests. You can still download CSV.

One-time Google setup for the deployment owner:

1. In [Google Cloud Console](https://console.cloud.google.com/), create/select a project and enable **Google Sheets API**.
2. Configure the Google Auth Platform consent screen (app name, support email, audience). For an External app in Testing, add each intended Google account as a test user.
3. Create an OAuth client with application type **Web application**. Add your exact deployed origin to **Authorized JavaScript origins**, for example `https://twitt-rose.vercel.app` (no path or trailing slash). Also add `http://localhost:8000` for local use if needed. Open the local app with that exact hostname. Each preview domain needs its own authorized origin; using one stable production domain is easiest. This popup token flow does not use an application redirect endpoint.
4. Add `GOOGLE_CLIENT_ID` in **Vercel → Settings → Environment Variables**, using the public OAuth client ID ending in `.apps.googleusercontent.com`. Redeploy. No client secret, service-account key, or Google API key is needed.
5. Allow popups, click the export button, and approve Google's file permission. If Google blocks access, check the exact JavaScript origin, client ID, enabled Sheets API, consent audience/test users, and any Workspace administrator restrictions. Publishing a consent app beyond test users may require additional Google configuration or review.

Authorization requests only `https://www.googleapis.com/auth/drive.file`, so it can create and edit files you use with this app rather than access every spreadsheet. The Google access token stays in browser memory for that export; it is not stored in localStorage, cookies, the repository, or sent to the Python/X server. The public client ID is intentionally returned to the browser; it is not a secret. The X bearer token remains server-side.

Exports use Google Sheets' `RAW` input mode with string values to preserve long IDs and prevent post text from becoming formulas. Images are URL fields, not embedded pictures. Uploads are batched, and **Open Google spreadsheet** links to the created file. On a write failure, **Resume Google Sheets export** retries fixed ranges in the same file without duplicating rows. Keep the tab open to resume; refreshing loses the local export state. A lost response while creating a file can leave an empty file in Drive. Cells longer than Sheets' 50,000-character limit stop export with an explanation; CSV remains available.

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

Use **Posts per month → 10** and select a single month to test with up to 10 posts. Options are 5 (default), 10, 50, 100, and 500. For the smallest test, leave the default at 5. X archive search requires at least 10 results per request, so a five-post collection may fetch 10 from X while displaying/exporting only the first 5. These are live searches and still use your X API allowance; selecting several months applies the limit to each month.

Enter `#solar`, `"clean energy"`, or `(#solar OR #wind) lang:en -is:retweet`. The server groups your query and appends `lang:en` to require English posts, including every OR branch. Only posts X identifies with `lang=en` are returned; language detection is supplied by X. Other search operators are preserved. Select an inclusive month range of up to 24 months. Calendar boundaries use UTC; the current month ends at collection time. Future months are rejected.

For each month, the app requests full-archive results with `sort_order=relevancy`, paginating until it reaches your selected limit (up to 500 unique posts) or X has no more matches. Posts retain the order X returns them across pages. The app does not apply its own ranking or reorder posts by engagement. Preview and CSV have the same order, grouped by month from earliest to latest. Engagement metrics are included as metadata and reflect collection time. Deleted and inaccessible posts cannot be collected. Months with fewer matches yield fewer rows.


### Research data processing

- The app sends your query wrapped in parentheses with `lang:en` appended, your UTC month boundaries, and `sort_order=relevancy` to X's full-archive API. This is X's relevance setting, not a custom scoring formula or the personalized X website feed.
- Responses are paginated in the order X provides. Posts not labeled `lang=en` by X are excluded. Duplicate post IDs retain their first occurrence and its metadata. Collection stops at your chosen number of unique English posts per month or when X supplies no next page.
- Months are combined from earliest to latest. Within each month, X's response order is preserved in the preview, CSV, and Google Sheets. No engagement thresholds, custom scoring formulas, calculated engagement-score columns, or engagement-based sorting are applied.
- Likes, reposts, replies, quotes, and other available public metrics are copied individually from X. Their values reflect collection time, not the historical month selected. Unavailable metrics stay empty. `raw_json` preserves the returned post, author, and directly attached media objects for comparison with the flattened columns.
- Column names and nested JSON formatting are normalized for tabular export; `month` and a post URL are added. CSV quotes/escapes cells and prefixes formula-like text with an apostrophe for spreadsheet safety. Its unprefixed original remains in `raw_json`. Google Sheets uses RAW string writes to preserve IDs and literal text. These export formats do not reorder rows or calculate metrics.
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
```

With Playwright/Chromium available and the local app running, run `APP_BASE_URL=http://127.0.0.1:8000 python3 tests/browser_smoke.py` and `APP_BASE_URL=http://127.0.0.1:8000 python3 tests/sheets_browser.py` for simulated end-to-end checks.

Backend tests use simulated X responses for calendar boundaries, pagination, metadata, preservation of X result order, CSV escaping, same-origin request checks, and stateless search. Browser checks additionally exercise multi-month previews, images, show-more pagination, and the actual generated CSV download. Live API validation requires your token and uses your API allowance. Local verification does not establish a successful Vercel deployment.
