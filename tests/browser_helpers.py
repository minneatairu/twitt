"""Explicit checkpoint transfer helpers for session-only browser regression tests."""
import json

def reload_with_checkpoint(page):
    # Equivalent to downloading a checkpoint before reload and explicitly importing it.
    saved = page.evaluate('() => CollectionStore.loadReplies()')
    page.reload()
    page.wait_for_function("() => !document.getElementById('prepare-replies').disabled")
    assert page.locator('#reply-controls').is_hidden(), 'A refresh must not restore a session automatically'
    if saved:
        page.locator('#reply-checkpoint-file').set_input_files({'name':'manual-checkpoint.json', 'mimeType':'application/json','buffer':json.dumps(saved).encode()})
        page.wait_for_function("() => document.getElementById('reply-status').textContent.includes('Checkpoint restored')")
