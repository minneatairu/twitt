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
                elif 'deleteDimension' in request:
                    assert request['deleteDimension']['range']['startIndex'] == 8
                    for row in logs:
                        if len(row) > 8: row.pop(8)
                    cells["'Logs'!A1"][0].pop(8)
                    replies.append({})
                else:
                    replies.append({})
            return route.fulfill(json={'replies': replies})
        if '/values/' not in path:
            return route.fulfill(json={'sheets': [{'properties': s} for s in sheets]})
        cell = path.split('/values/')[1]
        if method == 'GET':
            return route.fulfill(json={'values': logs if cell == "'Logs'!A:A" else cells.get("'Logs'!A1" if cell == "'Logs'!A1:J1" else cell, [])})
        if counters['fail'] and cell.startswith("'Logs'!A") and method != 'GET':
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
        page.locator('#selected-posts-file').set_input_files({'name': 'solar.csv', 'mimeType': 'text/csv', 'buffer': b'id,conversation_id,text,replies\n100,100,Root,10\n101,100,Selected reply,0\n'})
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
    assert len(sheets) == 1, 'Reporting must not create month tabs'
    assert len(logs) == 2
    summary = logs[1]
    assert summary[2:8] == ['#solar', '2024-06-01 – 2024-06-30', 2, 1, 3, 'paused_budget'], summary
    assert summary[1].endswith('Z')
    assert summary[8] == 1
    assert '0 reported replies' in cells["'Logs'!A1"][0][8]
    assert cells["'Logs'!A1"][0][9] == 'Model name'
    assert summary[9] == 'Unclassified'
    assert 'A reply' not in json.dumps(cells)
    assert 'Selected reply' not in json.dumps(cells)
    # Simulate the earlier workbook schema and verify the unused column migrates safely.
    cells["'Logs'!A1"][0].insert(8, 'Result tab')
    logs[1].insert(8, 'June 2024')
    page.click('#run-replies')
    page.wait_for_function('() => document.getElementById("report-status").textContent.includes("status: complete")')
    assert len(logs) == 2, 'Resuming updates one log row'
    assert logs[1][4:8] == [2, 2, 4, 'complete']
    assert len(logs[1]) == 10 and logs[1][8] == 1
    assert logs[1][9] == 'Unclassified'
    assert 'Result tab' not in cells["'Logs'!A1"][0]
    assert len(sheets) == 1, 'Resuming only updates Logs'
    page.on('dialog', lambda dialog: dialog.accept())
    page.click('#clear-replies')
    import_and_connect(connect=False)
    page.wait_for_function('() => document.getElementById("report-status").textContent.includes("Report saved")')
    assert counters['workbooks'] == 1, 'Reuse the central workbook across jobs'
    assert len(logs) == 3
    assert logs[2][8] == 1
    assert len(sheets) == 1
    checkpoint = page.evaluate('() => CollectionStore.loadReplies()')
    assert 'test-token' not in json.dumps(checkpoint)
    attempts = counters['x']
    page.reload()
    page.wait_for_function('() => !document.getElementById("prepare-replies").disabled')
    assert page.locator('#reply-checkpoint-file').count() == 0
    assert page.locator('#reply-controls').is_hidden()
    assert counters['x'] == attempts
    assert not errors, errors
    browser.close()
    print('PASS: centralized workbook, UTC metadata, unique counts, one Logs tab across multiple jobs, automatic upload, retry without X refetch or duplicate tabs/logs.')
