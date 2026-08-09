#!/usr/bin/env python3
"""Parse the logs CSV and extract identification-phase LLM calls."""
import csv
import json
import os
import sys
from pathlib import Path

# Ensure we can handle the very long fields
csv.field_size_limit(sys.maxsize if hasattr(sys, 'maxsize') else 2**31 - 1)
try:
    csv.field_size_limit(2**31 - 1)
except OverflowError:
    csv.field_size_limit(2**30)

CSV_PATH = r"e:/Work/ebike/repos/ebike-backend/docs/thread-extraction/736b1b30-d7da-4ddf-8504-a6957b64c789-logs.csv"
OUT_PATH = r"e:/Work/ebike/repos/ebike-backend/.tmp/identification-subtrees.json"

IDENTIFICATION_PROMPT_PREFIX = "You identify which products each Reddit comment references."
RECEIVED_MARKER = "AI chat response received [openai:gpt-5.4-mini]"


def find_json_payload(line: str):
    """Find the JSON metadata object in a Loki log line.

    The log line typically looks like a free-form string with an embedded JSON object.
    We try to find the largest balanced { ... } substring that parses as JSON.
    """
    # Find candidate starts (likely the metadata blob comes after the message text)
    candidates = []
    for start in range(len(line)):
        if line[start] != '{':
            continue
        # try to balance braces
        depth = 0
        in_str = False
        escape = False
        for end in range(start, len(line)):
            ch = line[end]
            if escape:
                escape = False
                continue
            if ch == '\\':
                escape = True
                continue
            if ch == '"':
                in_str = not in_str
                continue
            if in_str:
                continue
            if ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    candidate = line[start:end + 1]
                    try:
                        obj = json.loads(candidate)
                        if isinstance(obj, dict):
                            candidates.append(obj)
                    except json.JSONDecodeError:
                        pass
                    break
    if not candidates:
        return None
    # Pick the candidate with most keys (likely the full metadata)
    return max(candidates, key=lambda d: len(d.keys()) if isinstance(d, dict) else 0)


def extract_identification_calls():
    rows = []
    with open(CSV_PATH, 'r', encoding='utf-8', newline='') as f:
        reader = csv.DictReader(f)
        for row in reader:
            line = row.get('Line', '')
            if not line:
                continue
            if RECEIVED_MARKER not in line:
                continue
            # Quick filter: ensure prompt prefix appears in the line at all
            if IDENTIFICATION_PROMPT_PREFIX not in line:
                continue
            payload = find_json_payload(line)
            if not payload:
                continue
            messages = payload.get('messages')
            if not isinstance(messages, list) or len(messages) < 2:
                continue
            sys_msg = messages[0]
            sys_content = sys_msg.get('content') if isinstance(sys_msg, dict) else None
            if not isinstance(sys_content, str):
                continue
            if not sys_content.startswith(IDENTIFICATION_PROMPT_PREFIX):
                continue
            user_msg = messages[1]
            user_content = user_msg.get('content') if isinstance(user_msg, dict) else None
            response = payload.get('response', '')
            chat_id = payload.get('chatId') or payload.get('chat_id') or ''
            subtree_id = payload.get('subtreeId') or payload.get('subtree_id') or ''
            ts_ns = row.get('tsNs') or ''
            rows.append({
                'tsNs': ts_ns,
                'chatId': chat_id,
                'subtreeId': subtree_id,
                'userPrompt': user_content if isinstance(user_content, str) else json.dumps(user_content),
                'response': response if isinstance(response, str) else json.dumps(response),
            })
    # Sort chronologically (oldest first). tsNs is a numeric string.
    def sort_key(r):
        try:
            return int(r['tsNs'])
        except Exception:
            return 0
    rows.sort(key=sort_key)
    return rows


def main():
    calls = extract_identification_calls()
    out = {
        'subtreeCount': len(calls),
        'subtrees': [
            {
                'chatId': c['chatId'],
                'subtreeId': c['subtreeId'],
                'userPrompt': c['userPrompt'],
                'response': c['response'],
            }
            for c in calls
        ],
    }
    Path(os.path.dirname(OUT_PATH)).mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"Found {len(calls)} identification calls")
    print(f"Wrote: {OUT_PATH}")
    if calls:
        first = calls[0]
        print(f"\nFirst subtreeId: {first['subtreeId']}")
        print(f"First chatId: {first['chatId']}")
        prompt = first['userPrompt']
        # Find Comments section and show first ~2000 chars
        idx = prompt.find('## Comments')
        if idx >= 0:
            snippet = prompt[idx:idx + 1500]
        else:
            snippet = prompt[:1500]
        print("\n--- First subtree comments section snippet ---")
        print(snippet)


if __name__ == '__main__':
    main()
