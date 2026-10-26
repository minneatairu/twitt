"""Local X archive search and CSV export. Python 3.12+, no dependencies."""
import csv
import io
import json
import os
import re
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).parent
API = 'https://api.x.com/2/tweets/search/all'
FIELDS = ['month', 'id', 'url', 'text', 'created_at', 'author_id', 'username',
          'author_name', 'author_verified', 'author_followers', 'language',
          'likes', 'reposts', 'replies', 'quotes', 'bookmarks', 'impressions',
          'hashtags', 'mentions', 'urls', 'conversation_id',
          'in_reply_to_user_id', 'referenced_posts', 'attachments', 'images', 'media', 'geo', 'raw_json']


def month_bounds(start, end):
    if not all(isinstance(v, str) and re.fullmatch(r'\d{4}-\d{2}', v) for v in (start, end)):
        raise ValueError('Choose a valid start and end month.')
    first = datetime.strptime(start, '%Y-%m').replace(tzinfo=timezone.utc)
    last = datetime.strptime(end, '%Y-%m').replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    if first > last or first > now or first.year < 2006:
        raise ValueError('Select an ordered month range from 2006 through the present.')
    months = []
    current = first
    while current <= last:
        following = current.replace(year=current.year + 1, month=1) if current.month == 12 else current.replace(month=current.month + 1)
        if current >= now:
            raise ValueError('The range cannot include future months.')
        months.append((current.strftime('%Y-%m'), current.isoformat().replace('+00:00', 'Z'),
                       min(following, now).isoformat(timespec='seconds').replace('+00:00', 'Z')))
        if len(months) > 24:
            raise ValueError('Collect at most 24 months per export.')
        current = following
    return months


def english_query(query):
    # Group the entire user query so OR branches cannot bypass the language filter.
    query = f'({query.strip()}) lang:en'
    if len(query) > 1024:
        raise ValueError('Shorten the query to leave room for the English-language filter.')
    return query


def validate(data):
    query = data.get('query', '')
    if not isinstance(query, str) or not query.strip() or len(query) > 1024:
        raise ValueError('Enter a search query of 1–1024 characters.')
    budget = data.get('candidates', 5)
    if type(budget) is not int or budget not in (5, 10, 50, 100, 500):
        raise ValueError('Choose 5, 10, 50, 100, or 500 posts per month.')
    return query.strip(), month_bounds(data.get('start'), data.get('end')), budget


def request_page(params):
    token = os.environ.get('X_BEARER_TOKEN') or os.environ.get('TWITTER_BEARER_TOKEN')
    if not token:
        raise ValueError('Set X_BEARER_TOKEN in environment settings and restart the server.')
    request = Request(API + '?' + urlencode(params), headers={'Authorization': 'Bearer ' + token})
    try:
        with urlopen(request, timeout=45) as response:
            return json.load(response)
    except HTTPError as exc:
        messages = {401: 'X rejected the bearer token. Check its configuration.',
                    403: 'X denied access. Check full-archive search permissions and network access.',
                    429: 'X rate or usage limit reached. Wait or check your API usage allowance.',
                    402: 'X requires additional credits or an eligible API plan.'}
        raise ValueError(messages.get(exc.code, f'X returned HTTP {exc.code}. Check the query and API availability.')) from None
    except (URLError, TimeoutError):
        raise ValueError('Could not reach X. Check network access and retry.') from None


def to_row(post, users, month, media=None):
    author = users.get(post.get('author_id'), {})
    metrics = post.get('public_metrics', {})
    entities = post.get('entities', {})
    attached = [(media or {})[key] for key in post.get('attachments', {}).get('media_keys', []) if key in (media or {})]
    images = [item.get('url') if item.get('type') == 'photo' else item.get('preview_image_url') for item in attached]
    row_images = [url for url in images if url]
    row = dict.fromkeys(FIELDS, '')
    row.update(month=month, id=post['id'], url='https://x.com/i/web/status/' + post['id'],
               text=post.get('text', ''), created_at=post.get('created_at', ''),
               author_id=post.get('author_id', ''), username=author.get('username', ''),
               author_name=author.get('name', ''), author_verified=author.get('verified', ''),
               author_followers=author.get('public_metrics', {}).get('followers_count', ''),
               language=post.get('lang', ''),
               conversation_id=post.get('conversation_id', ''),
               in_reply_to_user_id=post.get('in_reply_to_user_id', ''))
    for column, key in [('likes', 'like_count'), ('reposts', 'retweet_count'),
                        ('replies', 'reply_count'), ('quotes', 'quote_count'),
                        ('bookmarks', 'bookmark_count'), ('impressions', 'impression_count')]:
        row[column] = metrics.get(key, '')
    for column, key, value in [('hashtags', 'hashtags', 'tag'), ('mentions', 'mentions', 'username'),
                               ('urls', 'urls', 'expanded_url')]:
        row[column] = json.dumps([item.get(value, '') for item in entities.get(key, [])], ensure_ascii=False)
    for column, key in [('referenced_posts', 'referenced_tweets'), ('attachments', 'attachments'), ('geo', 'geo')]:
        row[column] = json.dumps(post.get(key, [] if column == 'referenced_posts' else {}), ensure_ascii=False)
    row['images'] = json.dumps(row_images, ensure_ascii=False)
    row['media'] = json.dumps(attached, ensure_ascii=False)
    row['raw_json'] = json.dumps({'post': post, 'author': author, 'media': attached}, ensure_ascii=False)
    return row


def collect(query, months, budget, progress, fetch=request_page, pause=time.sleep):
    rows, summary = [], []
    for month, start, end in months:
        posts, users, media, next_token, seen_tokens = {}, {}, {}, None, set()
        exhausted = False
        while len(posts) < budget:
            params = {'query': english_query(query), 'start_time': start, 'end_time': end,
                      'max_results': min(500, budget - len(posts)), 'sort_order': 'relevancy',
                      'tweet.fields': 'created_at,author_id,lang,public_metrics,entities,conversation_id,in_reply_to_user_id,referenced_tweets,attachments,geo',
                      'expansions': 'author_id,attachments.media_keys',
                      'media.fields': 'media_key,type,url,preview_image_url,width,height,alt_text', 'user.fields': 'name,username,verified,public_metrics'}
            # X full-archive search requires at least 10 results per request.
            params['max_results'] = max(10, params['max_results'])
            if next_token:
                params['next_token'] = next_token
            payload = fetch(params)
            if payload.get('errors'):
                raise ValueError('X returned an incomplete search response. No partial CSV was published; retry or narrow the query.')
            for user in payload.get('includes', {}).get('users', []):
                users[user['id']] = user
            for item in payload.get('includes', {}).get('media', []):
                media[item['media_key']] = item
            for post in payload.get('data', []):
                if post.get('lang') == 'en' and len(posts) < budget and post['id'] not in posts:
                    posts[post['id']] = post
            progress(f'{month}: searched {len(posts):,} candidates')
            next_token = payload.get('meta', {}).get('next_token')
            if not next_token:
                exhausted = True
                break
            if next_token in seen_tokens:
                raise ValueError('X repeated a pagination token. Retry the search.')
            seen_tokens.add(next_token)
            if len(posts) < budget:
                pause(1.1)
        selected = list(posts.values())[:min(500, budget)]
        rows.extend(to_row(post, users, month, media) for post in selected)
        summary.append({'month': month, 'candidates': len(posts), 'exported': len(selected), 'exhausted': exhausted})
        pause(1.1)
    return rows, summary


def csv_bytes(rows):
    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fieldnames=FIELDS)
    writer.writeheader()
    for row in rows:
        # Protect spreadsheet users from formulas embedded in public post text.
        writer.writerow({k: ("'" + v if isinstance(v, str) and v.lstrip().startswith(('=', '+', '-', '@')) else v)
                         for k, v in row.items()})
    return output.getvalue().encode('utf-8-sig')



def search_page(data, fetch=None):
    """One bounded X request; no background work or process-local session state."""
    query, months, budget = validate(data)
    if len(months) != 1:
        raise ValueError('Each request must cover exactly one month.')
    count = data.get('count', 100)
    if type(count) is not int or not 10 <= count <= 500:
        raise ValueError('Page size must be between 10 and 500.')
    # X requires a minimum of ten per archive request, even for a five-post export.
    count = max(10, min(count, budget))
    token = data.get('next_token')
    if token is not None and (not isinstance(token, str) or len(token) > 4096):
        raise ValueError('Invalid pagination token.')
    month, start, end = months[0]
    fixed_end = data.get('end_time')
    if fixed_end is not None:
        try:
            fixed = datetime.fromisoformat(fixed_end.replace('Z', '+00:00'))
            if fixed.tzinfo is None or not datetime.fromisoformat(start.replace('Z', '+00:00')) < fixed <= datetime.fromisoformat(end.replace('Z', '+00:00')):
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise ValueError('Invalid fixed search end time.') from None
        end = fixed_end
    params = {'query': english_query(query), 'start_time': start, 'end_time': end,
              'max_results': count, 'sort_order': 'relevancy',
              'tweet.fields': 'created_at,author_id,lang,public_metrics,entities,conversation_id,in_reply_to_user_id,referenced_tweets,attachments,geo',
              'expansions': 'author_id,attachments.media_keys',
              'media.fields': 'media_key,type,url,preview_image_url,width,height,alt_text',
              'user.fields': 'name,username,verified,public_metrics'}
    if token:
        params['next_token'] = token
    payload = (fetch or request_page)(params)
    if payload.get('errors'):
        raise ValueError('X returned an incomplete response. Collection stopped; retry or narrow the query.')
    users = {u['id']: u for u in payload.get('includes', {}).get('users', [])}
    media = {m['media_key']: m for m in payload.get('includes', {}).get('media', [])}
    return {'rows': [to_row(post, users, month, media) for post in payload.get('data', []) if post.get('lang') == 'en'],
            'next_token': payload.get('meta', {}).get('next_token'), 'end_time': end}


class Handler(BaseHTTPRequestHandler):
    def send(self, code, content, content_type='application/json; charset=utf-8'):
        if isinstance(content, dict):
            content = json.dumps(content).encode()
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; style-src 'self' https://accounts.google.com; script-src 'self' https://accounts.google.com; connect-src 'self' https://sheets.googleapis.com https://accounts.google.com https://oauth2.googleapis.com; frame-src https://accounts.google.com; img-src 'self' https://pbs.twimg.com; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ('/api/health', '/api/index', '/api/index.py'):
            return self.send(200, {'ok': True,
                'configured': bool(os.environ.get('X_BEARER_TOKEN') or os.environ.get('TWITTER_BEARER_TOKEN')),
                'google_client_id': os.environ.get('GOOGLE_CLIENT_ID', '')})
        files = {'/': ('index.html', 'text/html; charset=utf-8'), '/index.html': ('index.html', 'text/html; charset=utf-8'), '/app.js': ('app.js', 'text/javascript; charset=utf-8'), '/style.css': ('style.css', 'text/css; charset=utf-8'), '/sheets.js': ('sheets.js', 'text/javascript; charset=utf-8'), '/collection-store.js': ('collection-store.js', 'text/javascript; charset=utf-8')}
        if path in files:
            name, mime = files[path]
            return self.send(200, (ROOT / 'static' / name).read_bytes(), mime)
        self.send(404, {'error': 'Not found'})

    def do_POST(self):
        if urlsplit(self.path).path not in ('/api/search', '/api/index', '/api/index.py'):
            return self.send(404, {'error': 'Not found'})
        origin = self.headers.get('Origin')
        if origin and urlsplit(origin).netloc != self.headers.get('Host'):
            return self.send(403, {'error': 'Cross-origin requests are not allowed.'})
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.send(415, {'error': 'JSON required'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 8192:
                raise ValueError('Invalid request size.')
            data = json.loads(self.rfile.read(size))
            if not isinstance(data, dict):
                raise ValueError('Expected an object.')
            result = search_page(data)
            return self.send(200, result)
        except (ValueError, TypeError) as exc:
            return self.send(400, {'error': str(exc) if isinstance(exc, ValueError) else 'Invalid request.'})
        except Exception:
            return self.send(502, {'error': 'Search failed unexpectedly. Please retry.'})


if __name__ == '__main__':
    server = ThreadingHTTPServer((os.environ.get('HOST', '127.0.0.1'), int(os.environ.get('PORT', '8000'))), Handler)
    print('Twitt server started on port ' + str(server.server_port), flush=True)
    server.serve_forever()
