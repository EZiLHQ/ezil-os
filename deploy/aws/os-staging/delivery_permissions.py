#!/usr/bin/env python3
"""Generate the proposed delivery permissions for a chosen fixed document.

This never creates/attaches a policy. There is no approved role/document default.
The host's existing GetObject permission remains separate from GitHub's upload role.
"""
import argparse
import json
import re

from install_receipt import require
from staging_candidate import PINNED


def proposed_policy(document_name):
    require(re.fullmatch(r'EZiL-OS-Staging-InstallVerified-[A-Za-z0-9_-]+', document_name or ''), 'Choose the reviewed fixed document name')
    region = {'StringEquals': {'aws:RequestedRegion': 'ap-south-1'}}
    document = f'arn:aws:ssm:ap-south-1:452630323510:document/{document_name}'
    return {'Version': '2012-10-17', 'Statement': [
        {'Sid': 'UploadOnlyStagingArtifacts', 'Effect': 'Allow', 'Action': ['s3:PutObject'],
         'Resource': [f'arn:aws:s3:::{PINNED["artifact_bucket"]}/{PINNED["artifact_prefix"]}*'], 'Condition': region},
        {'Sid': 'DescribePinnedTarget', 'Effect': 'Allow', 'Action': ['ec2:DescribeInstances'],
         'Resource': ['*'], 'Condition': region},
        {'Sid': 'ReadExactInstaller', 'Effect': 'Allow', 'Action': ['ssm:GetDocument', 'ssm:DescribeDocument'],
         'Resource': [document], 'Condition': region},
        {'Sid': 'InvokeExactInstallerAndHost', 'Effect': 'Allow', 'Action': ['ssm:SendCommand'],
         'Resource': [document, f'arn:aws:ec2:ap-south-1:452630323510:instance/{PINNED["instance_id"]}'], 'Condition': region},
        {'Sid': 'ReadCommandOutcome', 'Effect': 'Allow', 'Action': ['ssm:GetCommandInvocation'],
         'Resource': ['*'], 'Condition': region},
        {'Sid': 'ReadOnlySharedStagingLease', 'Effect': 'Allow', 'Action': ['dynamodb:GetItem'],
         'Resource': ['arn:aws:dynamodb:us-east-1:452630323510:table/ezil-ci-staging'],
         'Condition': {'StringEquals': {'aws:RequestedRegion': 'us-east-1'},
                       'ForAllValues:StringEquals': {'dynamodb:LeadingKeys': ['shared-staging']},
                       'Null': {'dynamodb:LeadingKeys': 'false'}}},
    ]}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('document_name', help='Proposed name only; rendering does not authorize its creation')
    print(json.dumps(proposed_policy(parser.parse_args().document_name), indent=2))
