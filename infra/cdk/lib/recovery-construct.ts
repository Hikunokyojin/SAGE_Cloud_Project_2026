import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as sns from "aws-cdk-lib/aws-sns";

export interface RecoveryConstructProps {
  instance: ec2.Instance;
  /** Existing operator alert topic; alarms notify it as well as acting. */
  alertTopic: sns.ITopic;
}

/**
 * Automatic recovery for the single Conductor instance (T2.2, option (a) of DP1).
 *
 * Three layers, all free:
 *  1. Process: systemd restarts conductor.service if Node exits (already on the instance).
 *  2. Operating system: if the instance status check fails for 3 minutes, CloudWatch
 *     reboots the instance.
 *  3. Hardware or host: if the system status check fails for 2 minutes, CloudWatch
 *     "recovers" the instance, moving it to healthy hardware with the same instance ID,
 *     private IP and Elastic IP, so API Gateway keeps working without any change.
 *
 * Missing data counts as healthy, so a deliberate pause (npm run backend:pause stops
 * the instance, which then sends no metrics) never raises an alarm or restarts it.
 */
export class RecoveryConstruct extends Construct {
  public readonly systemAlarm: cloudwatch.Alarm;
  public readonly instanceAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: RecoveryConstructProps) {
    super(scope, id);
    const notify = new actions.SnsAction(props.alertTopic);

    const statusMetric = (metricName: string) =>
      new cloudwatch.Metric({
        namespace: "AWS/EC2",
        metricName,
        dimensionsMap: { InstanceId: props.instance.instanceId },
        statistic: "Maximum",
        period: Duration.minutes(1),
      });

    this.systemAlarm = new cloudwatch.Alarm(this, "SystemCheckRecover", {
      alarmName: "sage-conductor-system-check-recover",
      alarmDescription: "Conductor host failed its system status check: EC2 auto-recovery moves it to healthy hardware.",
      metric: statusMetric("StatusCheckFailed_System"),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    this.systemAlarm.addAlarmAction(new actions.Ec2Action(actions.Ec2InstanceAction.RECOVER), notify);
    this.systemAlarm.addOkAction(notify);

    this.instanceAlarm = new cloudwatch.Alarm(this, "InstanceCheckReboot", {
      alarmName: "sage-conductor-instance-check-reboot",
      alarmDescription: "Conductor operating system failed its instance status check: the instance is rebooted.",
      metric: statusMetric("StatusCheckFailed_Instance"),
      threshold: 1,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    this.instanceAlarm.addAlarmAction(new actions.Ec2Action(actions.Ec2InstanceAction.REBOOT), notify);
    this.instanceAlarm.addOkAction(notify);
  }
}
