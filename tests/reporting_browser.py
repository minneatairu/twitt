"""Central reporting workbook, month tabs, cumulative counts, and upload recovery."""
import json
import os
from urllib.parse import unquote, urlsplit, parse_qs
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    page = browser.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    sheets = [{'sheetId': 0, 'title': 'Logs'}]
    cells = {}
    logs = [['Reply job ID']]
    counters = {'workbooks': 0, 'x': 0, 'fail': True}

    def api(route):
        if route.request.method == 'GET':
            return route.fulfill(json={'configured': True, 'google_client_id': 'public-test.apps.googleusercontent.com'})
        counters['x'] += 1
        body = route.request.post_data_json
        return route.fulfill(json={'rows': [{'id': str(899 + counters['x']), 'conversation_id': body['conversation_ids'][0], 'parent_post_id': '100', 'text': 'A reply', 'url': 'https://x.com/i/web/status/900'}], 'next_token': 'NEXT' if counters['x'] == 1 else None})

    def drive(route):
        query = parse_qs(urlsplit(route.request.url).query)
        if 'q' in query:
            if 'Data Reporting Workbook' in query['q'][0]:
                return route.fulfill(json={'files': [{'id': 'report-book'}] if counters['workbooks'] else []})
            return route.fulfill(json={'files': [{'id': 'research-folder'}]})
        return route.fulfill(json={'parents': ['research-folder']})

    def google(route):
        path = unquote(urlsplit(route.request.url).path)
        method = route.request.method
        body = route.request.post_data_json if method != 'GET' else None
        if path == '/v4/spreadsheets':
            counters['workbooks'] += 1
            assert body['properties']['title'] == 'Data Reporting Workbook'
            return route.fulfill(json={'spreadsheetId': 'report-book'})
        if path.endswith(':batchUpdate'):
            replies = []
            for request in body['requests']:
                if 'addSheet' in request:
                    sheet = {'sheetId': len(sheets), **request['addSheet']['properties']}
                    sheets.append(sheet)
                    replies.append({'addSheet': {'properties': sheet}})
                else:
                    replies.append({})
            return route.fulfill(json={'replies': replies})
        if '/values/' not in path:
            return route.fulfill(json={'sheets': [{'properties': s} for s in sheets]})
        cell = path.split('/values/')[1]
        if method == 'GET':
            return route.fulfill(json={'values': logs if cell == "'Logs'!A:A" else cells.get(cell, [])})
        if counters['fail'] and 'June 2024' in cell:
            counters['fail'] = False
            return route.fulfill(status=429, json={'error': {'message': 'try later'}})
        if ':append' in cell:
            logs.extend(body['values'])
        elif cell.startswith("'Logs'!A") and cell != "'Logs'!A1":
            index = int(cell.split('!A')[1]) - 1
            logs[index] = body['values'][0]
        else:
            cells[cell] = body['values']
        return route.fulfill(json={'updatedRows': len(body['values'])})

    page.route('**/api/index', api)
    page.route('https://www.googleapis.com/drive/v3/files**', drive)
    page.route('https://sheets.googleapis.com/**', google)
    page.route('https://accounts.google.com/gsi/client', lambda route: route.fulfill(content_type='application/javascript', body='window.google={accounts:{oauth2:{initTokenClient(c){return {requestAccessToken(){c.callback({access_token:"test-token"})}}}}}};'))
    page.goto(os.environ.get('APP_BASE_URL', 'http://127.0.0.1:8000'))
    page.wait_for_function('() => !document.getElementById("prepare-replies").disabled')

    def import_and_connect(connect=True):
        page.locator('#selected-posts-file').set_input_files({'name': 'solar.csv', 'mimeType': 'text/csv', 'buffer': b'id,conversation_id,text\n100,100,Root\n101,100,Selected reply\n'})
        page.click('#prepare-replies')
        page.wait_for_function('() => !document.getElementById("reply-controls").hidden')
        page.fill('#report-term', '#solar')
        page.fill('#report-month', '2024-06')
        if connect:
            page.click('#connect-reporting')
            page.wait_for_function('() => document.getElementById("report-status").textContent.includes("connected")')
        page.click('#run-replies')

    import_and_connect()
    page.wait_for_function('() => document.getElementById("report-status").textContent.includes("Report not saved")')
    assert counters['x'] == 1
    assert counters['workbooks'] == 1
    page.click('#retry-reporting')
    page.wait_for_function('() => document.getElementById("report-status").textContent.includes("Report saved")')
    assert counters['x'] == 1, 'Retry must never repeat X search'
    assert len(sheets) == 2, 'Retry must reuse the result tab'
    assert len(logs) == 2
    summary = logs[1]
    assert summary[2:8] == ['#solar', '2024-06-01 – 2024-06-30', 2, 1, 3, 'paused_budget'], summary
    assert summary[1].endswith('Z')
    assert summary[8] == 'June 2024'
    assert cells["'June 2024'!A1"][5][0] == 'id'
    page.click('#run-replies')
    page.wait_for_function('() => document.getElementById("report-status").textContent.includes("status: complete")')
    assert len(logs) == 2, 'Resuming updates one log row'
    assert logs[1][4:8] == [2, 2, 4, 'complete']
    assert len(sheets) == 2, 'Resuming updates the same month tab'
    page.on('dialog', lambda dialog: dialog.accept())
    page.click('#clear-replies')
    import_and_connect(connect=False)
    page.wait_for_function('() => document.getElementById("report-status").textContent.includes("Report saved")')
    assert counters['workbooks'] == 1, 'Reuse the central workbook across jobs'
    assert len(logs) == 3
    assert logs[2][-1] == 'June 2024 (2)'
    checkpoint = page.evaluate('() => CollectionStore.loadReplies()')
    assert 'test-token' not in json.dumps(checkpoint)
    attempts = counters['x']
    page.reload()
    page.wait_for_function('() => !document.getElementById("prepare-replies").disabled')
    page.locator('#reply-checkpoint-file').set_input_files({'name':'checkpoint.json', 'mimeType':'application/json', 'buffer':json.dumps(checkpoint).encode()})
    page.wait_for_function('() => document.getElementById("reply-status").textContent.includes("Checkpoint restored")')
    assert counters['x'] == attempts
    page.click('#connect-reporting')
    page.wait_for_function('() => document.getElementById("report-status").textContent.includes("Report saved")')
    assert counters['x'] == attempts
    assert len(sheets) == 3 and len(logs) == 3, 'Checkpoint reconnect reuses its tab and log row'
    assert not errors, errors
    browser.close()
    print('PASS: centralized workbook, UTC metadata, unique counts, month tabs, repeat-month tab, automatic upload, retry without X refetch or duplicate tabs/logs.')
