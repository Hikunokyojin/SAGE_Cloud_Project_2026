import { Construct } from "constructs";
import { RemovalPolicy } from "aws-cdk-lib";
import * as cloudtrail from "aws-cdk-lib/aws-cloudtrail";
import * as s3 from "aws-cdk-lib/aws-s3";

/**
 * Secondary audit layer required by spec S1/S3 (Milestone 3, task 16), distinct from
 * the DynamoDB agent_decisions table -- CloudTrail records AWS API activity (who
 * called what, when) across the account, not agent decisions. Single-region only
 * (this project runs entirely in ap-south-1) and management events only, not data
 * events -- keeps log volume/cost down for a demo-scale coursework project; data
 * events (e.g. every S3 GetObject) are not needed to audit "did someone change IAM/
 * Lambda/DynamoDB config" and would meaningfully increase cost for no benefit here.
 */
export class CloudTrailConstruct extends Construct {
  public readonly trail: cloudtrail.Trail;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const logBucket = new s3.Bucket(this, "TrailLogBucket", {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    this.trail = new cloudtrail.Trail(this, "SageTrail", {
      trailName: "sage-trail",
      bucket: logBucket,
      isMultiRegionTrail: false,
      includeGlobalServiceEvents: true, // IAM changes are recorded as global-service events even in a single-region trail
      managementEvents: cloudtrail.ReadWriteType.ALL,
      sendToCloudWatchLogs: false, // S3 delivery only -- CloudWatch Logs ingestion is an avoidable extra cost for a coursework demo
    });
  }
}
