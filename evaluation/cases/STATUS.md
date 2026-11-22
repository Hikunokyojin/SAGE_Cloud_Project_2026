# T4.2 status: on hold, waiting on the second labeller

Done (PR #51):
- `t42-cases.json`: 160 cases (50 single, 35 composition, 25 ambiguous, 25 out-of-catalogue, 25 adversarial).
- `labels-a.json`: labeller A's labels.
- Blind labelling page for labeller B: https://claude.ai/artifact/7j7qStCU6f9Z9wxcwrtS4E (share as Editor or Contributor).
- `agreement.py`: Cohen's kappa, confusion matrix, disagreement list, `resolved.json`.

To resume:
1. Labeller B finishes on the page.
2. Read the page's `labels` store into a folder and run `python -I evaluation/cases/agreement.py <folder>`.
3. Resolve every disagreement in `resolved.json`; record kappa in the docs.
4. Run SAGE on all 160 cases, score against `resolved.json`, and report L4 (out-of-catalogue refusal rate).
