"""mum -> prd vocabulary for the offline suite.

fixture.py renders a prd case (fixtures and the fake AWS/npm/docker tools) through
it; assert.py first proves that a prd run named no mum resource, then checks it with
the unchanged mum assertions. The two pins stand in for the reviewed post-P4 commit.
"""
PRD_LAUNCH_TEMPLATE = "lt-0aaaaaaaaaaaaaaaa"
PRD_REPOSITORY = "452630323510.dkr.ecr.ap-south-1.amazonaws.com/ezil-prd-foundation-applicationimages439f25f1-milwdio3nbs6"
PRD = (
    ("ezil-mum-", "ezil-prd-"),
    ("ezil-host-mum", "ezil-host-prd"),
    ("lt-06f691fc1e4dfe3cc", PRD_LAUNCH_TEMPLATE),
    ("ezil-os/billing-staging/app", "ezil-os/production/app"),
    ("https://os-staging.ezil.work", "https://os-prod.ezil.work"),
    ('"namespace": "mum"', '"namespace": "prd"'),
)
MUM_TOKENS = ("ezil-mum-", "ezil-host-mum", "lt-06f691fc1e4dfe3cc", "billing-staging", "os-staging", "/root/ezil-aws-mum")
# Pin stand-ins, applied to the copied scripts only (test-only, like the lock paths).
PINS = (
    ("            repository=\n", f"            repository={PRD_REPOSITORY}\n"),
    ("            launch_template=\n", f"            launch_template={PRD_LAUNCH_TEMPLATE}\n"),
    ('"repository": None, "launchTemplate": None,', f'"repository": "{PRD_REPOSITORY}", "launchTemplate": "{PRD_LAUNCH_TEMPLATE}",'),
)


def to_prd(text):
    for mum, prd in PRD:
        text = text.replace(mum, prd)
    return text


def to_mum(text):
    for mum, prd in reversed(PRD):
        text = text.replace(prd, mum)
    return text
