#!/usr/bin/env python3
"""Prepare a NEW dedicated recovery bucket. Dry-run unless --apply is supplied.

Uses the existing boto3 credential chain. No exports, uploads, keys, IAM grants,
retention rules or schedules. Existing buckets are never adopted or changed.
"""
import argparse
import json
import re

import boto3
from botocore.exceptions import ClientError


def configuration(bucket, account, administrator):
    if not re.fullmatch(r"[0-9]{12}", account):
        raise ValueError("Invalid expected account")
    if not re.fullmatch(r"sagerock-private-backups-[a-z0-9-]+", bucket):
        raise ValueError("A dedicated sagerock-private-backups-* bucket is required")
    if not administrator.startswith(f"arn:aws:iam::{account}:user/"):
        raise ValueError("This provisioning workflow requires a confirmed IAM user")
    resources = [f"arn:aws:s3:::{bucket}", f"arn:aws:s3:::{bucket}/*"]
    return {
        "public_access": dict.fromkeys(
            ["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"], True),
        "ownership": {"Rules": [{"ObjectOwnership": "BucketOwnerEnforced"}]},
        "encryption": {"Rules": [{"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}]},
        "policy": {"Version": "2012-10-17", "Statement": [
            {"Sid": "DenyUnencryptedTransport", "Effect": "Deny", "Principal": "*",
             "Action": "s3:*", "Resource": resources,
             "Condition": {"Bool": {"aws:SecureTransport": "false"}}},
            {"Sid": "DenyDataOutsideRecoveryAdministration", "Effect": "Deny", "Principal": "*",
             "Action": ["s3:GetObject*", "s3:PutObject*", "s3:DeleteObject*", "s3:RestoreObject",
                        "s3:ListBucket", "s3:ListBucketVersions", "s3:ListBucketMultipartUploads",
                        "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
             "Resource": resources,
             "Condition": {"ArnNotEquals": {"aws:PrincipalArn": [administrator, f"arn:aws:iam::{account}:root"]}}},
        ]},
    }


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--bucket", required=True)
    p.add_argument("--account", required=True)
    p.add_argument("--region", default="us-east-2")
    p.add_argument("--apply", action="store_true")
    args = p.parse_args()
    identity = boto3.client("sts").get_caller_identity()
    if identity["Account"] != args.account:
        raise ValueError("AWS identity does not match the expected account")
    config = configuration(args.bucket, args.account, identity["Arn"])
    s3 = boto3.client("s3", region_name=args.region)
    owner = {"Bucket": args.bucket, "ExpectedBucketOwner": args.account}
    try:
        s3.head_bucket(**owner)
    except ClientError as exc:
        if exc.response["ResponseMetadata"]["HTTPStatusCode"] != 404:
            raise
    else:
        raise ValueError("Bucket already exists; this tool will not change existing buckets")
    print(json.dumps({"bucket": args.bucket, "region": args.region, "apply": args.apply,
                      "configuration": config, "versioning": "Enabled",
                      "expiration": "none", "uploads": "none"}, indent=2))
    if not args.apply:
        return
    create = {"Bucket": args.bucket, "ObjectOwnership": "BucketOwnerEnforced"}
    if args.region != "us-east-1":
        create["CreateBucketConfiguration"] = {"LocationConstraint": args.region}
    s3.create_bucket(**create)
    # If configuration fails, retain the new empty bucket for explicit repair.
    # Never delete a bucket as automatic rollback or upload before verification.
    s3.put_public_access_block(**owner, PublicAccessBlockConfiguration=config["public_access"])
    s3.put_bucket_versioning(**owner, VersioningConfiguration={"Status": "Enabled"})
    s3.put_bucket_encryption(**owner, ServerSideEncryptionConfiguration=config["encryption"])
    s3.put_bucket_policy(**owner, Policy=json.dumps(config["policy"]))
    s3.put_bucket_tagging(**owner, Tagging={"TagSet": [
        {"Key": "Purpose", "Value": "private-recovery"},
        {"Key": "ManagedBy", "Value": "jax-recovery"},
    ]})
    checks = {
        "public_access_blocked": s3.get_public_access_block(**owner)["PublicAccessBlockConfiguration"] == config["public_access"],
        "acls_disabled": s3.get_bucket_ownership_controls(**owner)["OwnershipControls"] == config["ownership"],
        "versioning_enabled": s3.get_bucket_versioning(**owner).get("Status") == "Enabled",
        "encryption_enabled": s3.get_bucket_encryption(**owner)["ServerSideEncryptionConfiguration"]["Rules"][0]["ApplyServerSideEncryptionByDefault"]["SSEAlgorithm"] == "AES256",
        "policy_matches": json.loads(s3.get_bucket_policy(**owner)["Policy"]) == config["policy"],
        "policy_not_public": s3.get_bucket_policy_status(**owner)["PolicyStatus"]["IsPublic"] is False,
        "empty": s3.list_objects_v2(**owner, MaxKeys=1).get("KeyCount") == 0,
    }
    print(json.dumps({"verification": checks}, indent=2))
    if not all(checks.values()):
        raise ValueError("Bucket verification incomplete; do not upload")


if __name__ == "__main__":
    try:
        main()
    except ClientError as exc:
        raise SystemExit(f"AWS operation failed: {exc.response['Error']['Code']}; no backup created")
    except ValueError as exc:
        raise SystemExit(str(exc))
