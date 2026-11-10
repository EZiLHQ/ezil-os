"""mum -> prd vocabulary for the offline suite.

fixture.py renders a prd case (fixtures and the fake AWS/npm/docker tools) through
it; assert.py first proves that a prd run named no mum resource, then checks it with
the unchanged mum assertions. The two pins are the committed ezil-prd-foundation outputs.
"""
PRD_LAUNCH_TEMPLATE = "lt-0b68cfb18ad22869a"
PRD_REPOSITORY = "452630323510.dkr.ecr.ap-south-1.amazonaws.com/ezil-prd-foundation-applicationimages439f25f1-xkgzfggtz2w4"
PRD = (
    ("ezil-mum-foundation-applicationimages439f25f1-milwdio3nbs6", PRD_REPOSITORY.split("/", 1)[1]),
    ("/tmp/ezil-mum.", "/tmp/ezil-prd."),
    ("ezil-mum-", "ezil-prd-"),
    ("ezil-host-mum", "ezil-host-prd"),
    ("lt-06f691fc1e4dfe3cc", PRD_LAUNCH_TEMPLATE),
    ("ezil-os/billing-staging/app", "ezil-os/production/app"),
    ("https://os-staging.ezil.work", "https://os-prod.ezil.work"),
    ('"namespace": "mum"', '"namespace": "prd"'),
)
MUM_TOKENS = ("ezil-mum-", "ezil-host-mum", "lt-06f691fc1e4dfe3cc", "billing-staging", "os-staging", "/root/ezil-aws-mum")
# Emptied pins for the explicitly unpinned cases, applied to the copied scripts only (test-only, like the lock paths).
UNPIN = (
    (f"            repository={PRD_REPOSITORY}\n", "            repository=\n"),
    (f"            launch_template={PRD_LAUNCH_TEMPLATE}\n", "            launch_template=\n"),
    (f'"repository": f"{{ACCOUNT}}.dkr.ecr.{{REGION}}.amazonaws.com/{PRD_REPOSITORY.split("/", 1)[1]}",\n            "launchTemplate": "{PRD_LAUNCH_TEMPLATE}",',
     '"repository": None,\n            "launchTemplate": None,'),
)


def to_prd(text):
    for mum, prd in PRD:
        text = text.replace(mum, prd)
    return text


def to_mum(text):
    # The specific repository pair (PRD[0]) must invert before the generic "ezil-prd-" prefix does.
    for mum, prd in (PRD[0], *reversed(PRD[1:])):
        text = text.replace(prd, mum)
    return text
