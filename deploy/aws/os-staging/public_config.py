#!/usr/bin/env python3
"""Public browser-auth build identity; never prints the key or invents approval."""
import hashlib
import json
import os
from pathlib import Path
import re

from install_receipt import require


def fingerprint(identity):
    return hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def identity(url, key):
    # Receipt creation preserves legacy operator build inputs. Automatic delivery
    # separately requires the explicitly approved HTTPS target below.
    require(isinstance(url, str) and url, 'Missing public Supabase URL')
    require(isinstance(key, str) and key, 'Missing public Supabase key')
    return {'supabase_url': url, 'anon_key_sha256': hashlib.sha256(key.encode()).hexdigest()}


def approved(contract):
    value = contract.get('public_config')
    require(isinstance(value, dict) and set(value) == {'supabase_url', 'anon_key_sha256'} and
            re.fullmatch(r'https://[a-z0-9][a-z0-9.-]*', value.get('supabase_url', '')) and
            re.fullmatch(r'[0-9a-f]{64}', value.get('anon_key_sha256', '')),
            'No approved staging public browser-auth configuration')
    return value


def validate(contract, env):
    expected = approved(contract)
    actual = identity(env.get('NEXT_PUBLIC_SUPABASE_URL'), env.get('NEXT_PUBLIC_SUPABASE_ANON_KEY'))
    require(actual == expected, 'Public browser-auth configuration differs from approved staging identity')
    return fingerprint(actual)


if __name__ == '__main__':
    print(validate(json.loads(Path(__file__).with_name('pipeline.json').read_text()), os.environ))
