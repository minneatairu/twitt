# Twitt

Search X by keyword or hashtag across a selectable month range, preview up to **500 posts per month** with attached images, and download the same results as a metadata-rich CSV.

## Deploy on Vercel

1. Import this repository into Vercel, or run `npx vercel` from the repository root after authenticating with `npx vercel login`.
2. Use the **Other** framework preset. `vercel.json` explicitly builds `api/index.py` with `@vercel/python` and `static/**` with `@vercel/static`; no frontend build or dependencies are required. Leave the project Root Directory at the repository root and remove any Output Directory override. The configuration routes `/api/index` to the Python function and serves the static home page and assets. Set the function maximum duration to at least 60 seconds in Vercel project settings if your plan supports it; upstream X requests time out after 45 seconds. Python 3.12 is pinned in `.python-version`.
3. Add these **server-side environment variables** to the deployment environments you use:
   - `X_BEARER_TOKEN`: your X API bearer token with full-archive search access.
   - `APP_PASSWORD`: a strong, unique password you enter in the app before searching. Share it only with people allowed to spend your API allowance. Hosted searches fail closed when it is missing.
4. Deploy/redeploy to apply the variables. Open the deployed site, enter the access password, search, inspect the results, and download the CSV.

Do not prefix either variable with `NEXT_PUBLIC_` or expose it in frontend code. The app sends the X token only from the Python function to `https://api.x.com/2/tweets/search/all`. Vercel environment variables are separate from Codex cloud environment settings. API charges and deployment usage follow your X and Vercel plans. No Vercel project or public deployment is created merely by adding these files.

### How the hosted app works

Each browser request fetches one X page (up to 100 candidates), with the search cursor passed explicitly to the next request. There are no background threads, database, shared process state, or durable jobs. This works across Vercel function instances and keeps each request bounded. A slow X request can still time out; failures stop collection without automatic retries.

The browser collects results per month in X’s response order, renders a paginated preview of text, author, date, engagement, images, and video previews, then generates the CSV locally. Completed months become visible while later months are still collecting. A failed collection does not generate a complete CSV. Earlier completed months remain visible. Keep the tab open during collection. Results disappear on refresh, closing the tab, or starting another search; download the CSV to keep them. There is no saved-results history or shareable dataset URL.

The app password protects searches, not the static home page. This is a private research tool with a shared password, not a public multi-user service. Use Vercel Deployment Protection as an additional access control where available. Anyone with your app password can use your API allowance.

## Local development

Requires Python 3.12+; no third-party runtime packages or build step.

Configure `X_BEARER_TOKEN` securely in the process environment, then run:

```sh
cd /workspace/twitt
python3 app.py
```

The default bind address is `127.0.0.1`, port `8000`. `HOST` and `PORT` can override it. `APP_PASSWORD` is optional locally and mandatory when `VERCEL` is set. `.env` files are not loaded automatically. Never commit secrets. `/api/index` reports token presence and whether an access password is required, without exposing values.

## Search and result order

Use **Posts per month → 10 · quick test** and select a single month to test with up to 10 posts. Options are 10, 50, 100, and 500 (default). These are live searches and still use your X API allowance; selecting several months applies the limit to each month.

Enter `#solar`, `"clean energy"`, or `(#solar OR #wind) lang:en -is:retweet`. X search operators pass through unchanged. Select an inclusive month range of up to 24 months. Calendar boundaries use UTC; the current month ends at collection time. Future months are rejected.

For each month, the app requests full-archive results with `sort_order=relevancy`, paginating until it reaches your selected limit (up to 500 unique posts) or X has no more matches. Posts retain the order X returns them across pages. The app does not apply its own ranking or reorder posts by engagement. Preview and CSV have the same order, grouped by month from earliest to latest. Engagement metrics are included as metadata and reflect collection time. Deleted and inaccessible posts cannot be collected. Months with fewer matches yield fewer rows.

Failures stop collection without retries to avoid unexpected duplicate charges. Retrying starts a new search and can consume additional allowance. A present token alone does not establish valid permissions or credits.

## Images and CSV

The web preview shows directly attached photos and video previews, 24 posts at a time. Images load directly from `pbs.twimg.com`, which must be allowed by any browser/environment network policy. Images from external links and quoted/reposted bodies are not separately expanded. Media can become unavailable if deleted or access changes.

CSV columns include post ID/URL/text/time, author ID/name/username/verification/follower count, language, likes/reposts/replies/quotes/bookmarks/impressions when supplied, engagement score, hashtags, mentions, URLs, conversation/reply references, attachments, geo, image URLs, media metadata/dimensions/alt text, and raw post/author/media JSON. Nested fields are JSON strings; missing fields stay empty. Images are linked, not embedded or downloaded into the CSV. Use the web preview to view them. The UTF-8 BOM supports spreadsheets; formula-like cells are prefixed with an apostrophe. Import long ID columns as text.

Respect X developer terms, retention/deletion obligations, and applicable privacy requirements.

## Validation

```sh
python3 -m unittest discover -s tests -v
node --check static/app.js
```

Backend tests use simulated X responses for calendar boundaries, pagination, metadata, preservation of X result order, CSV escaping, access control, and stateless search. Browser checks additionally exercise multi-month previews, images, show-more pagination, and the actual generated CSV download. Live API validation requires your token and uses your API allowance. Local verification does not establish a successful Vercel deployment.
