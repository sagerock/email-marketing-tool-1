"""Dedicated, temporary S3 upload credentials for supervised recovery work."""
import argparse
import json
import time
import uuid

import boto3
from botocore.exceptions import ClientError

ROLE_NAME = "SageRockRecoveryWriter"


def writer_policy(bucket, project):
    return {"Version": "2012-10-17", "Statement": [{
        "Effect": "Allow", "Action": ["s3:PutObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
        "Resource": [f"arn:aws:s3:::{bucket}/production/supabase/{project}/*",
                     f"arn:aws:s3:::{bucket}/synthetic-drills/writer/*"],
    }]}


def assume_writer(account, region):
    result = boto3.client("sts").assume_role(
        RoleArn=f"arn:aws:iam::{account}:role/{ROLE_NAME}",
        RoleSessionName="supervised-recovery-" + uuid.uuid4().hex[:10], DurationSeconds=3600)
    c = result["Credentials"]
    return boto3.client("s3", region_name=region, aws_access_key_id=c["AccessKeyId"],
                        aws_secret_access_key=c["SecretAccessKey"], aws_session_token=c["SessionToken"])


def provision(account, bucket, project, region, apply=False):
    identity = boto3.client("sts").get_caller_identity()
    if identity["Account"] != account or not identity["Arn"].startswith(f"arn:aws:iam::{account}:user/"):
        raise ValueError("Expected provisioning account and IAM user required")
    if not bucket.startswith("sagerock-private-backups-") or not project.isalnum():
        raise ValueError("Invalid dedicated backup destination")
    iam = boto3.client("iam")
    s3 = boto3.client("s3", region_name=region)
    owner = {"Bucket": bucket, "ExpectedBucketOwner": account}
    trust = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow",
             "Principal": {"AWS": identity["Arn"]}, "Action": "sts:AssumeRole"}]}
    policy = writer_policy(bucket, project)
    bucket_policy = json.loads(s3.get_bucket_policy(**owner)["Policy"])
    restrictions = [s for s in bucket_policy["Statement"] if s.get("Sid") == "DenyDataOutsideRecoveryAdministration"]
    if len(restrictions) != 1:
        raise ValueError("Existing recovery bucket policy does not match expected contract")
    allowed = restrictions[0]["Condition"]["ArnNotEquals"]["aws:PrincipalArn"]
    role_arn = f"arn:aws:iam::{account}:role/{ROLE_NAME}"
    if set(allowed) - {identity["Arn"], f"arn:aws:iam::{account}:root", role_arn}:
        raise ValueError("Unexpected recovery principals; manual review required")
    try:
        role = iam.get_role(RoleName=ROLE_NAME)["Role"]
    except iam.exceptions.NoSuchEntityException:
        role = None
    if role:
        if role["AssumeRolePolicyDocument"] != trust:
            raise ValueError("Existing role trust differs; not adopting it")
        existing = iam.get_role_policy(RoleName=ROLE_NAME, PolicyName="RecoveryUploadsOnly")["PolicyDocument"]
        if existing != policy or iam.list_attached_role_policies(RoleName=ROLE_NAME)["AttachedPolicies"]:
            raise ValueError("Existing role has unexpected permissions")
        if iam.list_role_policies(RoleName=ROLE_NAME)["PolicyNames"] != ["RecoveryUploadsOnly"]:
            raise ValueError("Additional role policies require review")
    if not apply:
        return {"mode": "plan", "role": role_arn, "new_role": role is None, "policy": policy}
    if not role:
        iam.create_role(RoleName=ROLE_NAME, AssumeRolePolicyDocument=json.dumps(trust),
                        Description="Supervised encrypted recovery uploads; no read, delete or bucket administration",
                        Tags=[{"Key": "Purpose", "Value": "private-recovery"}])
        iam.put_role_policy(RoleName=ROLE_NAME, PolicyName="RecoveryUploadsOnly", PolicyDocument=json.dumps(policy))
    if role_arn not in allowed:
        allowed.append(role_arn)
        s3.put_bucket_policy(**owner, Policy=json.dumps(bucket_policy))
    if json.loads(s3.get_bucket_policy(**owner)["Policy"]) != bucket_policy:
        raise ValueError("Bucket policy readback failed")
    for attempt in range(3):
        try:
            writer = assume_writer(account, region)
            break
        except ClientError:
            if attempt == 2:
                raise
            time.sleep(3)
    key = "synthetic-drills/writer/" + uuid.uuid4().hex + ".txt"
    uploaded = writer.put_object(**owner, Key=key, Body=b"Synthetic writer-access probe; no client data.\n",
                                 ServerSideEncryption="AES256")
    if not uploaded.get("VersionId") or uploaded["VersionId"] == "null":
        raise ValueError("Writer upload lacks a version ID")
    denials = {}
    for name, operation in [("read", writer.get_object), ("delete", writer.delete_object)]:
        try:
            operation(**owner, Key=key)
        except ClientError as exc:
            denials[name] = exc.response["Error"]["Code"] == "AccessDenied"
        else:
            denials[name] = False
    try:
        writer.put_object(**owner, Key="synthetic-drills/outside-writer/" + uuid.uuid4().hex,
                          Body=b"Synthetic scope probe; no client data.", ServerSideEncryption="AES256")
    except ClientError as exc:
        denials["outside_prefix_write"] = exc.response["Error"]["Code"] == "AccessDenied"
    else:
        denials["outside_prefix_write"] = False
    if not all(denials.values()):
        raise ValueError("Writer is not limited to uploads")
    return {"mode": "applied", "role": role_arn, "write_verified": True, "denials": denials,
            "long_lived_access_key_created": False, "synthetic_key": key}


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--account", required=True)
    p.add_argument("--bucket", required=True)
    p.add_argument("--project", required=True)
    p.add_argument("--region", default="us-east-2")
    p.add_argument("--apply", action="store_true")
    args = vars(p.parse_args())
    try:
        print(json.dumps(provision(**args), indent=2))
    except ClientError as exc:
        raise SystemExit("AWS operation failed: " + exc.response["Error"]["Code"])
