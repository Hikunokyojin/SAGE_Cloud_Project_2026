import { Construct } from "constructs";
import * as budgets from "aws-cdk-lib/aws-budgets";

export interface BudgetConstructProps {
  /** Monthly cost limit in USD -- sized against the AWS student credit allowance (spec S3 must-have 12 / plan task 14a). */
  limitUsd: number;
  /** Email notified when spend crosses the alert thresholds below. */
  alertEmail: string;
}

/**
 * AWS Budgets alert against the student credit allowance (Milestone 2, task 14a --
 * the one gap noted in docs/PROJECT_PLAN.md's Milestone 2 status). Two thresholds:
 * 80% of ACTUAL spend (something has already been spent, worth a heads-up) and 100%
 * of FORECASTED spend (current trend will exceed the limit before month-end even if
 * it hasn't yet) -- catches both "already overspending" and "about to."
 */
export class BudgetConstruct extends Construct {
  constructor(scope: Construct, id: string, props: BudgetConstructProps) {
    super(scope, id);

    const subscriber: budgets.CfnBudget.SubscriberProperty = {
      subscriptionType: "EMAIL",
      address: props.alertEmail,
    };

    new budgets.CfnBudget(this, "MonthlyCostBudget", {
      budget: {
        budgetName: "sage-monthly-cost-budget",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: {
          amount: props.limitUsd,
          unit: "USD",
        },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: "ACTUAL",
            comparisonOperator: "GREATER_THAN",
            threshold: 80,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [subscriber],
        },
        {
          notification: {
            notificationType: "FORECASTED",
            comparisonOperator: "GREATER_THAN",
            threshold: 100,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [subscriber],
        },
      ],
    });
  }
}
