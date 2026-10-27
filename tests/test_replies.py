import io
import json
import time
import unittest
from urllib.error import HTTPError
from unittest.mock import patch

import app


class ReplySearchTests(unittest.TestCase):
    def data(self, **kwargs):
        return dict({'conversation_id': '100', 'start_time': '2024-01-01T00:00:00Z',
                     'end_time': '2024-05-01T00:00:00Z', 'count': 100, 'next_token': 'saved-cursor'}, **kwargs)

    def test_reply_parent_mapping_and_exact_search_parameters(self):
        payload = {'data': [
            {'id': '501', 'lang': 'en', 'conversation_id': '100', 'text': 'Reply to root',
             'referenced_tweets': [{'type': 'replied_to', 'id': '100'}]},
            {'id': '502', 'lang': 'en', 'conversation_id': '100',
             'referenced_tweets': [{'type': 'quoted', 'id': '900'}, {'type': 'replied_to', 'id': '200'}]},
            {'id': '503', 'lang': 'es', 'conversation_id': '100', 'referenced_tweets': [{'type': 'replied_to', 'id': '100'}]},
            {'id': '504', 'lang': 'en', 'conversation_id': '999', 'referenced_tweets': [{'type': 'replied_to', 'id': '100'}]},
            {'id': '505', 'lang': 'en', 'conversation_id': '100'}], 'meta': {'next_token': 'next-cursor'}}
        with patch('app.request_page', return_value=payload) as fetch:
            result = app.replies_page(self.data())
        params = fetch.call_args.args[0]
        self.assertEqual(params['query'], 'conversation_id:100 is:reply lang:en')
        self.assertEqual(params['sort_order'], 'recency')
        self.assertEqual(params['next_token'], 'saved-cursor')
        self.assertEqual(params['start_time'], self.data()['start_time'])
        self.assertEqual(params['end_time'], self.data()['end_time'])
        self.assertEqual([row['parent_post_id'] for row in result['rows']], ['100', '200'])
        self.assertEqual(result['next_token'], 'saved-cursor')
        self.assertTrue(result['incomplete'])
        self.assertEqual(result['unresolved_count'], 2)
        self.assertEqual(result['scanned_count'], 5)

    def test_reject_invalid_ids_windows_and_page_sizes(self):
        for values in [{'conversation_id': '100 OR keyword'}, {'count': 5}, {'next_token': ''},
                       {'end_time': '2099-01-01T00:00:00Z'}, {'start_time': '2024-06-01T00:00:00Z'},
                       {'start_time': '2024-01-01'}]:
            with self.subTest(values=values), self.assertRaises(ValueError):
                app.replies_page(self.data(**values), fetch=lambda _: self.fail('Invalid request reached X'))

    def test_multiple_conversations_share_one_request(self):
        payload = {'data': [
            {'id': '501', 'lang': 'en', 'conversation_id': '100', 'referenced_tweets': [{'type': 'replied_to', 'id': '100'}]},
            {'id': '502', 'lang': 'en', 'conversation_id': '300', 'referenced_tweets': [{'type': 'replied_to', 'id': '300'}]},
            {'id': '503', 'lang': 'en', 'conversation_id': '999', 'referenced_tweets': [{'type': 'replied_to', 'id': '999'}]}],
            'meta': {'result_count': 3}}
        with patch('app.request_page', return_value=payload) as fetch:
            result = app.replies_page(self.data(conversation_ids=['100', '300'], count=500))
        fetch.assert_called_once()
        self.assertEqual(fetch.call_args.args[0]['query'], '(conversation_id:100 OR conversation_id:300) is:reply lang:en')
        self.assertEqual(fetch.call_args.args[0]['max_results'], 500)
        self.assertEqual([row['conversation_id'] for row in result['rows']], ['100', '300'])

    def test_batch_rejects_duplicates_and_overlong_queries(self):
        for ids in [[], ['100', '100'], ['100', '300 OR is:retweet'], [str(1000000000000000000 + i) for i in range(40)]]:
            with self.subTest(ids=ids), self.assertRaises(ValueError):
                app.replies_page(self.data(conversation_ids=ids), fetch=lambda _: self.fail('Invalid batch reached X'))

    def test_partial_response_is_not_successful(self):
        result = app.replies_page(self.data(next_token='saved'), fetch=lambda _: {'data': [], 'errors': [{'title': 'Unavailable'}]})
        self.assertTrue(result['incomplete'])
        self.assertEqual(result['next_token'], 'saved')
        self.assertIn('Unavailable', result['warning'])

    def test_malformed_success_does_not_claim_exhaustion(self):
        result = app.replies_page(self.data(), fetch=lambda _: {})
        self.assertTrue(result['incomplete'])
        self.assertIn('omitted pagination metadata', result['warning'])

    def test_hydration_failure_preserves_verifiable_rows_and_cursor(self):
        good = {'id':'501', 'lang':'en', 'conversation_id':'100',
                'referenced_tweets':[{'type':'replied_to', 'id':'100'}]}
        payload = {'data':[good, {'id':'502', 'lang':'en', 'conversation_id':'100'}],
                   'meta':{'next_token':'unsafe-next'},
                   'errors':[{'title':'Field Hydration Error', 'detail':'referenced_tweets incomplete'}]}
        result = app.replies_page(self.data(next_token='saved'), fetch=lambda _: payload)
        self.assertEqual([row['id'] for row in result['rows']], ['501'])
        self.assertTrue(result['incomplete'])
        self.assertEqual(result['unresolved_count'], 1)
        self.assertEqual(result['next_token'], 'saved')
        payload['data'] = [good]
        result = app.replies_page(self.data(), fetch=lambda _: payload)
        self.assertFalse(result['incomplete'])
        self.assertEqual(result['next_token'], 'unsafe-next')
        self.assertIn('referenced_tweets incomplete', result['warning'])

    def test_conversation_scope_accepts_nested_replies_without_parent_metadata(self):
        payload = {'data':[
            {'id':'501', 'conversation_id':'100', 'lang':'en', 'referenced_tweets':[{'type':'replied_to','id':'999'}]},
            {'id':'502', 'conversation_id':'100'},
            {'id':'503', 'conversation_id':'100', 'lang':'es'}],
            'meta':{'next_token':'next'}, 'errors':[{'title':'Field Hydration Error','detail':'references missing'}]}
        with patch('app.request_page', return_value=payload) as fetch:
            result = app.replies_page(self.data(scope='conversation'))
        self.assertFalse(result['incomplete'])
        self.assertEqual(result['next_token'], 'next')
        self.assertEqual([row['id'] for row in result['rows']], ['501','502'])
        self.assertEqual([row['parent_post_id'] for row in result['rows']], ['999',''])
        self.assertNotIn('in_reply_to_user_id', fetch.call_args.args[0]['tweet.fields'])
        self.assertTrue(all(row['post_type'] == 'reply' for row in result['rows']))

    def test_rate_limit_carries_reset_time(self):
        reset = time.time() + 120
        error = HTTPError(app.API, 429, 'limited', {'x-rate-limit-reset': str(reset)}, io.BytesIO(b'{"title":"Too Many Requests"}'))
        with patch.dict('os.environ', {'X_BEARER_TOKEN': 'test-only-token'}), patch('app.urlopen', side_effect=error):
            with self.assertRaises(app.XAPIError) as caught:
                app.request_page({'query': 'test'})
        self.assertEqual(caught.exception.code, 'rate_limited')
        self.assertEqual(caught.exception.retry_at, reset)

    def test_usage_caps_are_not_automatically_retried(self):
        error = HTTPError(app.API, 429, 'limited', {'x-rate-limit-reset': str(time.time() + 120)},
                          io.BytesIO(b'{"title":"UsageCapExceeded","detail":"Monthly usage limit reached"}'))
        with patch.dict('os.environ', {'X_BEARER_TOKEN': 'test-only-token'}), patch('app.urlopen', side_effect=error):
            with self.assertRaises(app.XAPIError) as caught:
                app.request_page({'query': 'test'})
        self.assertEqual(caught.exception.code, 'usage_limit')
        self.assertIsNone(caught.exception.retry_at)

    def test_rejected_cursor_is_explicit(self):
        error = HTTPError(app.API, 400, 'bad cursor', {}, io.BytesIO(b'{}'))
        with patch.dict('os.environ', {'X_BEARER_TOKEN': 'test-only-token'}), patch('app.urlopen', side_effect=error):
            with self.assertRaises(app.XAPIError) as caught:
                app.request_page({'query': 'test', 'next_token': 'expired-cursor'})
        self.assertEqual(caught.exception.code, 'cursor_invalid')
        self.assertIn('not restarted', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
