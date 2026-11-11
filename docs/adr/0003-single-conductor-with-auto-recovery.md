# 0003: One Conductor instance with automatic recovery

**Status:** accepted for the pilot (decision DP1, option a), 2026-11.

## Context

The Conductor is steady, always-on orchestration, so it runs on EC2, while the bursty, isolated agents run on Lambda. One instance is a single point of failure. The alternatives are an Auto Scaling group across two zones behind a load balancer (the load balancer costs money), or moving orchestration into Lambda or Step Functions (which reverses a documented design decision).

## Decision

Keep one t3.micro with three free recovery layers:
- systemd restarts the process;
- a CloudWatch alarm reboots the instance on an operating-system failure;
- a second alarm recovers it onto healthy hardware on a host failure, keeping the same Elastic IP.

## Consequences

- Measured (EVALUATION.md): a process crash recovers in 3.7 s, and a reboot in 24 s with no manual step.
- Not covered: a deliberately stopped instance (`backend:resume` starts it again) and an outage of the whole Availability Zone.
- For a public launch, option (b), two zones and a load balancer, is the next step.
