#!/usr/bin/env python3
"""Render the fixed installer document for review. Never calls AWS or creates it."""
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def document_digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def definition(directory=HERE):
    verifier = (directory / 'install_receipt.py').read_text()
    installer = (directory / 'install-host.sh').read_text()
    # SSM Agent ENV_VAR interpolation avoids substituting untrusted parameter
    # text into shell code. Older agents fail closed on the required variables.
    body = '''set -euo pipefail
set +x
: "${SSM_Tag:?SSM Agent ENV_VAR support required}"
: "${SSM_SourceSha:?}"
: "${SSM_ReceiptSha256:?}"
identity_token=$(curl --noproxy '*' --fail --silent --show-error --connect-timeout 3 --max-time 5 --request PUT --header 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)
identity=$(curl --noproxy '*' --fail --silent --show-error --connect-timeout 3 --max-time 5 --header "X-aws-ec2-metadata-token: $identity_token" http://169.254.169.254/latest/dynamic/instance-identity/document)
unset identity_token
python3 - "$identity" <<'OS_INSTANCE_IDENTITY_PY'
import json, sys
identity = json.loads(sys.argv[1])
expected = {'instanceId': 'i-014810524754b9ed0', 'accountId': '452630323510', 'region': 'ap-south-1'}
if any(identity.get(key) != value for key, value in expected.items()):
    raise SystemExit('Fixed installer refused instance/account/region identity')
OS_INSTANCE_IDENTITY_PY
unset identity
verify_install_source() {
python3 - "$@" <<'OS_SOURCE_RECEIPT_PY'
''' + verifier + '''
OS_SOURCE_RECEIPT_PY
}
set -- "$SSM_Tag" ezil-main-preview-artifacts-452630323510-aps1 "$SSM_SourceSha" "$SSM_ReceiptSha256"
''' + installer
    return {
        'schemaVersion': '2.2',
        'description': 'Fixed OS staging verified installer; no caller shell, URL, bucket or target parameter.',
        'parameters': {name: {'type': 'String', 'allowedPattern': pattern, 'interpolationType': 'ENV_VAR'}
                       for name, pattern in {
                           'Tag': '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$',
                           'SourceSha': '^[0-9a-f]{40}$',
                           'ReceiptSha256': '^[0-9a-f]{64}$'}.items()},
        'mainSteps': [{'action': 'aws:runShellScript', 'name': 'verifiedStagingInstall',
                       'precondition': {'StringEquals': ['platformType', 'Linux']},
                       'inputs': {'timeoutSeconds': '900', 'runCommand': ["bash <<'OS_FIXED_INSTALLER'\n" + body + '\nOS_FIXED_INSTALLER']}}],
    }


if __name__ == '__main__':
    print(json.dumps(definition(), indent=2))
