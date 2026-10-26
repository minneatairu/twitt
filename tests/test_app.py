import csv
import io
import json
import os
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import app


class CollectionTests(unittest.TestCase):
    def test_calendar_boundaries_and_leap_year(self):
        months = app.month_bounds('2024-02', '2024-03')
        self.assertEqual(months[0], ('2024-02', '2024-02-01T00:00:00Z', '2024-03-01T00:00:00Z'))
        self.assertEqual(months[1][2], '2024-04-01T00:00:00Z')
        self.assertEqual(app.month_bounds('2023-12', '2024-01')[0][2], '2024-01-01T00:00:00Z')

    def test_invalid_ranges_and_budget(self):
        for start, end in [('2024-03', '2024-01'), ('2024-13', '2024-13'), ('2099-01', '2099-02'), ('2020-01', '2024-01')]:
            with self.subTest(start=start), self.assertRaises(ValueError):
                app.month_bounds(start, end)
        with self.assertRaises(ValueError):
            app.validate({'query': '#test', 'start': '2024-01', 'end': '2024-01', 'candidates': 999})

    def test_pagination_preserves_x_order_with_deduplication_and_media(self):
        calls = []
        def fetch(params):
            calls.append(params)
            if len(calls) == 1:
                return {'data': [{'lang': 'en', 'id': '1', 'text': 'low', 'author_id': 'a', 'public_metrics': {'like_count': 2}}],
                        'meta': {'next_token': 'page2'}}
            return {'data': [{'lang': 'en', 'id': '1', 'text': 'duplicate replacement', 'public_metrics': {'like_count': 999}},
                             {'lang': 'en', 'id': '2', 'text': 'high', 'author_id': 'a', 'attachments': {'media_keys': ['photo', 'video']}, 'public_metrics': {'like_count': 8, 'retweet_count': 3}}],
                    'includes': {'users': [{'id': 'a', 'username': 'researcher'}],
                                 'media': [{'media_key': 'photo', 'type': 'photo', 'url': 'https://pbs.twimg.com/media/example.jpg', 'alt_text': 'A test image'},
                                           {'media_key': 'video', 'type': 'video', 'preview_image_url': 'https://pbs.twimg.com/media/preview.jpg'}]}}
        rows, summary = app.collect('#test', app.month_bounds('2024-01', '2024-01'), 500, lambda _: None, fetch, lambda _: None)
        self.assertEqual([r['id'] for r in rows], ['1', '2'])
        self.assertEqual(rows[0]['text'], 'low')
        self.assertEqual(rows[0]['likes'], 2)
        self.assertEqual(rows[1]['likes'], 8)
        self.assertEqual(rows[1]['reposts'], 3)
        self.assertNotIn('engagement_score', rows[1])
        self.assertEqual(rows[1]['engagement'], '')
        self.assertEqual(app.FIELDS[app.FIELDS.index('quotes') + 1], 'engagement')
        self.assertEqual(rows[1]['username'], 'researcher')
        self.assertEqual(len(json.loads(rows[1]['images'])), 2)
        self.assertEqual(json.loads(rows[1]['media'])[0]['alt_text'], 'A test image')
        self.assertEqual(rows[0]['impressions'], '')
        self.assertEqual(summary[0]['exported'], 2)
        self.assertTrue(summary[0]['exhausted'])
        self.assertEqual(calls[1]['next_token'], 'page2')
        self.assertIn('attachments.media_keys', calls[0]['expansions'])
        self.assertEqual(calls[0]['sort_order'], 'relevancy')

    def test_500_limit_applies_to_each_month(self):
        def fetch(params):
            if 'next_token' in params:
                return {'data': [{'lang': 'en', 'id': 'extra', 'public_metrics': {'like_count': 10000}}]}
            return {'data': [{'lang': 'en', 'id': str(i), 'public_metrics': {'like_count': i}} for i in range(500)], 'meta': {'next_token': 'more'}}
        rows, summary = app.collect('test', app.month_bounds('2024-01', '2024-02'), 1000, lambda _: None, fetch, lambda _: None)
        self.assertEqual(len(rows), 1000)
        self.assertEqual([m['exported'] for m in summary], [500, 500])
        self.assertEqual(rows[0]['id'], '0')
        self.assertEqual(rows[500]['id'], '0')

    def test_small_test_collection_stops_at_ten(self):
        calls = []
        def fetch(params):
            calls.append(params)
            return {'data': [{'lang': 'en', 'id': str(i)} for i in range(10)],
                    'meta': {'next_token': 'more-available'}}
        rows, summary = app.collect('test', app.month_bounds('2024-01', '2024-01'), 10,
                                    lambda _: None, fetch, lambda _: None)
        self.assertEqual(len(rows), 10)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]['max_results'], 10)
        self.assertEqual(summary[0]['exported'], 10)

    def test_five_post_collection_requests_ten_and_keeps_first_five(self):
        calls = []
        def fetch(params):
            calls.append(params)
            return {'data': [{'id': str(i), 'lang': 'en'} for i in range(10)],
                    'meta': {'next_token': 'more'}}
        rows, _ = app.collect('#test', app.month_bounds('2024-01', '2024-01'), 5,
                              lambda _: None, fetch, lambda _: None)
        self.assertEqual([row['id'] for row in rows], ['0', '1', '2', '3', '4'])
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]['max_results'], 10)

    def test_partial_api_errors_are_not_success(self):
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            app.collect('x', app.month_bounds('2024-01', '2024-01'), 500, lambda _: None,
                        lambda _: {'data': [{'lang': 'en', 'id': '1'}], 'errors': [{'title': 'error'}]}, lambda _: None)

    def test_csv_unicode_newlines_and_formula_safety(self):
        row = app.to_row({'lang': 'en', 'id': '1234567890123456789', 'text': '=SUM(1,2)\n#café'}, {}, '2024-01')
        content = app.csv_bytes([row])
        parsed = list(csv.DictReader(io.StringIO(content.decode('utf-8-sig'))))
        self.assertEqual(parsed[0]['text'], "'=SUM(1,2)\n#café")
        self.assertEqual(parsed[0]['id'], '1234567890123456789')
        self.assertEqual(json.loads(parsed[0]['media']), [])

    def test_api_rate_limit_message_hides_credentials(self):
        error = HTTPError(app.API, 429, 'rate limited', {}, None)
        with patch.dict(os.environ, {'X_BEARER_TOKEN': 'test-token'}), patch('app.urlopen', side_effect=error):
            with self.assertRaisesRegex(ValueError, 'rate or usage limit'):
                app.request_page({'query': 'test'})


class ServerTests(unittest.TestCase):
    def test_vercel_entrypoint_is_a_concrete_handler_class(self):
        from api.index import handler
        self.assertEqual(handler.__name__, 'handler')
        self.assertTrue(issubclass(handler, app.Handler))

    @classmethod
    def setUpClass(cls):
        cls.server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        cls.base = 'http://127.0.0.1:' + str(cls.server.server_port)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_web_assets_and_health(self):
        for path in ['/', '/app.js', '/sheets.js', '/collection-store.js', '/style.css', '/api/health', '/api/index', '/api/index.py']:
            with self.subTest(path=path), urlopen(self.base + path) as response:
                self.assertEqual(response.status, 200)
                self.assertGreater(len(response.read()), 20)

    def test_google_configuration_exposes_only_public_client_id(self):
        with patch.dict(os.environ, {'GOOGLE_CLIENT_ID': 'public-client.apps.googleusercontent.com',
                                     'X_BEARER_TOKEN': 'private-test-token'}):
            with urlopen(self.base + '/api/index') as response:
                data = json.load(response)
            self.assertEqual(data['google_client_id'], 'public-client.apps.googleusercontent.com')
            self.assertTrue(data['configured'])
            self.assertNotIn('private-test-token', json.dumps(data))

    def test_stateless_search_returns_preview_and_export_metadata(self):
        payload = {'data': [{'lang': 'en', 'id': '100', 'text': 'Test post', 'attachments': {'media_keys': ['photo']}}],
                   'includes': {'media': [{'media_key': 'photo', 'type': 'photo', 'url': 'https://pbs.twimg.com/media/test.jpg'}]}}
        with patch('app.request_page', return_value=payload):
            request = Request(self.base + '/api/index', data=json.dumps({'query': '#test', 'start': '2024-01', 'end': '2024-01', 'candidates': 500}).encode(), headers={'Content-Type': 'application/json'})
            with urlopen(request) as response:
                result = json.load(response)
            self.assertEqual(len(result['rows']), 1)
            self.assertEqual(json.loads(result['rows'][0]['media'])[0]['type'], 'photo')
            self.assertEqual(result['rows'][0]['text'], 'Test post')
            self.assertIsNone(result['next_token'])

    def test_hosted_search_does_not_require_password(self):
        for legacy_password in ('', 'unused-old-password'):
            with self.subTest(legacy_password_present=bool(legacy_password)), patch.dict(os.environ, {'VERCEL': '1', 'APP_PASSWORD': legacy_password}), patch('app.request_page', return_value={'data': []}) as fetch:
                request = Request(self.base + '/api/index', data=json.dumps({'query': '#test', 'start': '2024-01', 'end': '2024-01', 'candidates': 10}).encode(), headers={'Content-Type': 'application/json'})
                with urlopen(request) as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(json.load(response)['rows'], [])
                fetch.assert_called_once()

    def test_page_cursor_is_forwarded_without_shared_state(self):
        with patch('app.request_page', return_value={'data': [], 'meta': {'next_token': 'third'}}) as fetch:
            result = app.search_page({'query': '#test', 'start': '2024-01', 'end': '2024-01', 'count': 100, 'candidates': 500, 'next_token': 'second'})
            self.assertEqual(result['next_token'], 'third')
            self.assertEqual(fetch.call_args.args[0]['next_token'], 'second')
            self.assertEqual(fetch.call_args.args[0]['max_results'], 100)

    def test_search_end_is_stable_across_pages(self):
        data = {'query': '#test', 'start': '2024-01', 'end': '2024-01',
                'end_time': '2024-01-20T12:00:00Z'}
        with patch('app.request_page', return_value={'data': []}) as fetch:
            result = app.search_page(data)
            self.assertEqual(fetch.call_args.args[0]['end_time'], data['end_time'])
            self.assertEqual(result['end_time'], data['end_time'])
        with self.assertRaises(ValueError):
            app.search_page(dict(data, end_time='2025-01-01T00:00:00Z'))

    def test_test_limit_caps_upstream_request(self):
        with patch('app.request_page', return_value={'data': []}) as fetch:
            app.search_page({'query': '#test', 'start': '2024-01', 'end': '2024-01',
                             'candidates': 10, 'count': 100})
            self.assertEqual(fetch.call_args.args[0]['max_results'], 10)

    def test_english_filter_covers_or_and_excludes_other_languages(self):
        payload = {'data': [{'id': '1', 'lang': 'en'}, {'id': '2', 'lang': 'es'},
                            {'id': '3'}, {'id': '4', 'lang': 'en'}]}
        with patch('app.request_page', return_value=payload) as fetch:
            result = app.search_page({'query': '#solar OR #wind', 'start': '2024-01', 'end': '2024-01'})
            params = fetch.call_args.args[0]
            self.assertEqual(params['query'], '(#solar OR #wind) lang:en')
            self.assertEqual(params['sort_order'], 'relevancy')
            self.assertEqual(params['max_results'], 10)
            self.assertEqual([row['id'] for row in result['rows']], ['1', '4'])
            self.assertEqual(app.validate({'query': 'test', 'start': '2024-01', 'end': '2024-01'})[2], 5)

    def test_cross_origin_cannot_start_paid_search(self):
        request = Request(self.base + '/api/index', data=b'{}', headers={'Content-Type': 'application/json', 'Origin': 'https://example.com'})
        with self.assertRaises(HTTPError) as caught:
            urlopen(request)
        self.assertEqual(caught.exception.code, 403)


if __name__ == '__main__':
    unittest.main()
