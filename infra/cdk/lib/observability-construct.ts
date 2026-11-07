import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as sns from "aws-cdk-lib/aws-sns";

export interface ObservabilityConstructProps {
  /** All 8 agent Lambdas. */
  functions: lambda.Function[];
  /** The two that call Groq, whose logs are searched for HTTP 429. */
  groqFunctions: lambda.Function[];
  /** The two that run when a request is handed to a human. */
  escalationFunctions: lambda.Function[];
  api: apigateway.RestApi;
  alertTopic: sns.ITopic;
}

/**
 * Observability (T2.5), all within the free tier:
 *  - five alarms (with the two recovery alarms, 7 of the 10 free ones), each emailing the
 *    alert topic, and treating missing data as healthy so a paused backend stays quiet;
 *  - X-Ray active tracing on every agent;
 *  - 30-day log retention instead of "never expire";
 *  - one CloudWatch dashboard with the same signals.
 */
export class ObservabilityConstruct extends Construct {
  constructor(scope: Construct, id: string, props: ObservabilityConstructProps) {
    super(scope, id);
    const notify = new actions.SnsAction(props.alertTopic);
    const five = Duration.minutes(5);
    const fnName = (fn: lambda.Function) => (fn.node.defaultChild as lambda.CfnFunction).functionName!;

    for (const fn of props.functions) {
      // Tracing switched on at the CloudFormation level so the existing functions are
      // updated in place; the role needs permission to send segments.
      (fn.node.defaultChild as lambda.CfnFunction).tracingConfig = { mode: "Active" };
      fn.addToRolePolicy(
        new iam.PolicyStatement({ actions: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"], resources: ["*"] })
      );
      // The log groups already exist (Lambda created them), so retention is set on them
      // rather than by declaring new log groups, which would fail as duplicates.
      new logs.LogRetention(this, `Retention-${fn.node.id}`, {
        logGroupName: `/aws/lambda/${fnName(fn)}`,
        retention: logs.RetentionDays.ONE_MONTH,
      });
    }

    const sum = (metrics: cloudwatch.IMetric[], label: string, period: Duration) =>
      new cloudwatch.MathExpression({
        expression: metrics.map((_, i) => `m${i}`).join(" + "),
        usingMetrics: Object.fromEntries(metrics.map((m, i) => [`m${i}`, m])),
        label,
        period,
      });

    const agentErrors = sum(
      props.functions.map((f) => f.metricErrors({ period: five, statistic: "Sum" })),
      "Agent errors",
      five
    );
    const hour = Duration.hours(1);
    const escalations = sum(
      props.escalationFunctions.map((f) => f.metricInvocations({ period: hour, statistic: "Sum" })),
      "Escalations per hour",
      hour
    );

    const groq429 = new cloudwatch.Metric({ namespace: "SAGE", metricName: "GroqRateLimited", statistic: "Sum", period: five });
    for (const fn of props.groqFunctions) {
      new logs.MetricFilter(this, `Groq429-${fn.node.id}`, {
        logGroup: logs.LogGroup.fromLogGroupName(this, `Logs-${fn.node.id}`, `/aws/lambda/${fnName(fn)}`),
        filterPattern: logs.FilterPattern.literal('"Groq API error (429)"'),
        metricNamespace: "SAGE",
        metricName: "GroqRateLimited",
        metricValue: "1",
        defaultValue: 0,
      });
    }

    const api5xx = props.api.metricServerError({ period: five, statistic: "Sum" });
    const apiP95 = props.api.metricLatency({ period: Duration.minutes(15), statistic: "p95" });

    const alarm = (id: string, name: string, description: string, metric: cloudwatch.IMetric, threshold: number) => {
      const a = new cloudwatch.Alarm(this, id, {
        alarmName: name,
        alarmDescription: description,
        metric,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      a.addAlarmAction(notify);
      a.addOkAction(notify);
      return a;
    };

    alarm("AgentErrors", "sage-agent-errors", "3 or more agent Lambda errors in 5 minutes.", agentErrors, 3);
    alarm("Api5xx", "sage-api-5xx", "5 or more HTTP 5XX responses from the API in 5 minutes.", api5xx, 5);
    alarm("ApiLatency", "sage-api-latency-p95", "p95 API latency of 15 s or more over 15 minutes.", apiP95, 15000);
    alarm("EscalationRate", "sage-escalation-rate", "10 or more requests handed to a human in an hour.", escalations, 10);
    alarm("Groq429", "sage-groq-rate-limited", "3 or more Groq rate-limit (429) errors in 5 minutes.", groq429, 3);

    new cloudwatch.Dashboard(this, "Dashboard", {
      dashboardName: "sage-operations",
      widgets: [
        [
          new cloudwatch.GraphWidget({ title: "API requests and 5XX", left: [props.api.metricCount({ period: five }), api5xx] }),
          new cloudwatch.GraphWidget({
            title: "API latency p50 / p95 (ms)",
            left: [props.api.metricLatency({ period: five, statistic: "p50" }), apiP95],
          }),
        ],
        [
          new cloudwatch.GraphWidget({ title: "Agent errors", left: [agentErrors] }),
          new cloudwatch.GraphWidget({
            title: "Agent duration p95 (ms)",
            left: props.functions.map((f) => f.metricDuration({ period: five, statistic: "p95" })),
          }),
        ],
        [
          new cloudwatch.GraphWidget({ title: "Escalations to a human", left: [escalations] }),
          new cloudwatch.GraphWidget({ title: "Groq rate-limit errors (429)", left: [groq429] }),
        ],
      ],
    });
  }
}
