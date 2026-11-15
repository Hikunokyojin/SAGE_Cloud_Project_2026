"""T4.2: agreement between labeller A and labeller B.

Run from the sage folder:  python -I evaluation/cases/agreement.py [labels-b.json]

labels-b.json holds labeller B's answers, either exported from the labelling page's
store as one JSON file per case (a folder) or pasted from the page's copy box
({"labeller": "B", "labels": {id: {outcome, steps, note}}}).
Writes evaluation/cases/agreement-report.md: Cohen's kappa on the outcome, exact
agreement on the service kinds, and every disagreement to resolve. Resolved answers go in
evaluation/cases/resolved.json ({id: {outcome, steps, reason}}); cases where A and B
agree are resolved automatically.
"""
import json
import pathlib
import sys
from collections import Counter

HERE = pathlib.Path(__file__).parent
OUTCOMES = ["serve", "review", "out_of_catalogue", "ambiguous", "block"]


def load_b(path: pathlib.Path) -> dict:
    if path.is_dir():
        return {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in path.rglob("*.json")}
    data = json.loads(path.read_text(encoding="utf-8"))
    return data.get("labels", data)


def cohen_kappa(a: list, b: list) -> float:
    n = len(a)
    po = sum(x == y for x, y in zip(a, b)) / n
    ca, cb = Counter(a), Counter(b)
    pe = sum(ca[k] * cb[k] for k in set(a) | set(b)) / (n * n)
    return 1.0 if pe == 1 else (po - pe) / (1 - pe)


def main() -> None:
    b_path = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "labels-b.json"
    cases = {c["id"]: c for c in json.loads((HERE / "t42-cases.json").read_text(encoding="utf-8"))["cases"]}
    la = json.loads((HERE / "labels-a.json").read_text(encoding="utf-8"))["labels"]
    lb = load_b(b_path)
    both = [cid for cid in cases if cid in lb and lb[cid].get("outcome")]
    missing = [cid for cid in cases if cid not in both]

    oa = [la[c]["outcome"] for c in both]
    ob = [lb[c]["outcome"] for c in both]
    kappa = cohen_kappa(oa, ob)
    agree = sum(x == y for x, y in zip(oa, ob))
    step_cases = [c for c in both if la[c]["outcome"] == lb[c]["outcome"] and la[c]["outcome"] in ("serve", "review")]
    step_agree = sum(la[c]["steps"] == lb[c].get("steps", []) for c in step_cases)

    resolved_path = HERE / "resolved.json"
    resolved = json.loads(resolved_path.read_text(encoding="utf-8")) if resolved_path.exists() else {}
    disagreements = []
    for c in both:
        a, b = la[c], lb[c]
        same = a["outcome"] == b["outcome"] and (a["outcome"] not in ("serve", "review") or a["steps"] == b.get("steps", []))
        if same:
            resolved.setdefault(c, {"outcome": a["outcome"], "steps": a["steps"], "reason": "A and B agree"})
        else:
            disagreements.append(c)
    resolved_path.write_text(json.dumps(resolved, indent=1) + "\n", encoding="utf-8")

    matrix = Counter(zip(oa, ob))
    lines = [
        "# T4.2 inter-annotator agreement",
        "",
        f"Cases labelled by both: **{len(both)} of {len(cases)}**" + (f" ({len(missing)} not yet labelled by B)" if missing else ""),
        "",
        f"- Outcome agreement: {agree} of {len(both)} ({agree / max(len(both), 1):.1%})",
        f"- **Cohen's kappa (outcome): {kappa:.3f}**",
        f"- Service kinds identical, where both chose the same serve/review outcome: {step_agree} of {len(step_cases)}",
        f"- Resolved answers: {sum(1 for c in cases if c in resolved)} of {len(cases)}; open disagreements: {sum(1 for c in disagreements if c not in resolved)}",
        "",
        "## Confusion matrix (rows A, columns B)",
        "",
        "| A \\ B | " + " | ".join(OUTCOMES) + " |",
        "|---|" + "---|" * len(OUTCOMES),
        *[f"| {r} | " + " | ".join(str(matrix[(r, k)]) for k in OUTCOMES) + " |" for r in OUTCOMES],
        "",
        "## Disagreements to resolve",
        "",
        "| Case | Type | Request | A | B | B's note | Resolved |",
        "|---|---|---|---|---|---|---|",
    ]
    fmt = lambda l: l["outcome"] + (f" ({' > '.join(l.get('steps') or [])})" if l.get("steps") else "")
    for c in disagreements:
        r = resolved.get(c)
        lines.append(f"| {c} | {cases[c]['type']} | {cases[c]['text'].replace('|', '/')} | {fmt(la[c])} | {fmt(lb[c])} | {(lb[c].get('note') or '').replace('|', '/')} | {fmt(r) if r else 'open'} |")
    (HERE / "agreement-report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"kappa {kappa:.3f}, agreement {agree}/{len(both)}, disagreements {len(disagreements)}, missing {len(missing)}")


if __name__ == "__main__":
    main()
