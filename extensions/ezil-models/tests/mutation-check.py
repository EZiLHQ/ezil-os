"""Offline mutation checks. Always restore source, including after a failed test command."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
source = root / 'src/gateway-messages.ts'
original = source.read_text()
mutations = [
    ('Kimi stream guard', "stream: model.model !== KIMI && model.stream !== false", "stream: model.stream !== false", 'Kimi never streams'),
    ('tool cap', 'result.length >= 64', 'result.length >= 640', 'tools cap keeps first 64'),
    ('cache option allowlist', 'model: model.model, messages: conversation.messages', '...request.modelOptions, model: model.model, messages: conversation.messages', 'cache_control is stripped'),
]
try:
    for name, before, after, test_name in mutations:
        assert original.count(before) == 1, name
        source.write_text(original.replace(before, after))
        result = subprocess.run(['bun', 'test', 'tests/gateway-messages.test.ts', '--test-name-pattern', test_name], cwd=root, text=True, capture_output=True)
        if result.returncode == 0 or '(fail)' not in result.stderr + result.stdout:
            raise SystemExit(f'Mutation was not killed: {name}\n{result.stdout}\n{result.stderr}')
        print(f'PASS: mutation detected: {name}')
        source.write_text(original)
finally:
    source.write_text(original)
