"""Compare alternative Laya question wordings for the recall judge.

Loads the model ONCE inside the Laya venv and scores every variant on two labelled sets:
  - tune set    (tests/fixtures/laya-recall-eval.jsonl): pick each variant's threshold here
  - holdout set (tests/fixtures/laya-recall-holdout.jsonl): unseen prompts, the honest score

Run (from the plugin folder):
  npm run laya:tune
  ~/.laya/venv/bin/python -B scripts/tune-laya-questions.py --out laya-tune-result.json

Only local files are read; prompts never leave the machine.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TUNE = ROOT / "tests" / "fixtures" / "laya-recall-eval.jsonl"
HOLDOUT = ROOT / "tests" / "fixtures" / "laya-recall-holdout.jsonl"
MAX_FP_RATE = 0.20

YES_NO_V0 = {
    "type": "choice",
    "instructions": "Does `text` need or benefit from retrieving past project memories, historical notes, or saved context?",
    "criteria": {
        "yes": "needs recalling past project context, previous decisions, pitfalls, or user preferences",
        "no": "general query, self-contained coding question, or greeting without past project context",
    },
}

YES_NO_STRICT = {
    "type": "choice",
    "instructions": (
        "Can `text` only be answered correctly by looking up something this specific user or team decided, "
        "agreed, preferred, or experienced earlier (their conventions, past decisions, earlier conversations, "
        "unfinished work)? Answer no when a competent engineer could fully answer from general knowledge plus "
        "the text itself, even if the text mentions code, bugs, projects, or tests."
    ),
    "criteria": {
        "yes": "refers to earlier decisions, agreed conventions, previous sessions, 'last time', 'as usual', 'our' rules or the user's own preferences",
        "no": "general programming question, explanation, writing or fixing code shown in the text, translation, formatting, or small talk",
    },
}

THREE_WAY = {
    "type": "choice",
    "instructions": "Classify `text` by what is needed to answer it.",
    "criteria": {
        "project_history": "needs this user's or team's earlier decisions, conventions, preferences, previous sessions, or past incidents",
        "self_contained": "a general or self-contained coding, writing, or knowledge request answerable without any history",
        "chitchat": "greeting, thanks, or small talk",
    },
}

SELF_CONTAINED_INVERTED = {
    "type": "choice",
    "instructions": (
        "Is everything needed to answer `text` contained in the text itself or in general public knowledge, "
        "with no reference to this user's earlier decisions, conventions, preferences, or past work?"
    ),
    "criteria": {
        "yes": "fully self-contained: general knowledge, code shown in the text, or small talk",
        "no": "depends on what this user or team decided, agreed, preferred, or did before",
    },
}

SCOPE = {
    "type": "choice",
    "instructions": "What is the appropriate memory scope for `text`?",
    "criteria": {
        "project": "project-specific facts, code decisions, local pitfalls, or repository context",
        "global": "user-wide global preferences, personal habits, or cross-project instructions",
        "unknown": "unclear, ambiguous, or general scope",
    },
}
CATEGORY = {
    "type": "choice",
    "instructions": "What type of memory is most relevant for `text`?",
    "criteria": {
        "pitfall": "known bugs, error workarounds, failure preventions, or debugging lessons",
        "decision": "architecture decisions, design rationales, conventions, and alternatives",
        "knowledge": "domain specifications, contracts, setups, and reference documentation",
    },
}

# name -> (questions dict, key to read, label whose probability means "needs memory", include task in state)
VARIANTS = {
    "v0_current": ({"requires_memory": YES_NO_V0, "scope": SCOPE, "category": CATEGORY}, "requires_memory", "yes", True),
    "v1_current_alone": ({"requires_memory": YES_NO_V0}, "requires_memory", "yes", False),
    "v2_strict_negatives": ({"requires_memory": YES_NO_STRICT}, "requires_memory", "yes", False),
    "v3_three_way": ({"needed": THREE_WAY}, "needed", "project_history", False),
    "v4_inverted": ({"self_contained": SELF_CONTAINED_INVERTED}, "self_contained", "no", False),
}


def load_rows(path: Path) -> list[dict]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            item = json.loads(line)
            rows.append({"text": item["text"], "recall": bool(item["recall"])})
    return rows


def load_agent(backend: str, model: str | None):
    if backend == "auto":
        backend = "mlx" if sys.platform == "darwin" else "pytorch"
    if backend == "mlx":
        import laya_mlx
        return laya_mlx.load(model or "aac6fef/laya-multilingual-mlx"), "mlx"
    import laya
    return laya.load(model or "convaiinnovations/laya-multilingual"), "pytorch"


def score(agent, variant, text: str) -> float:
    questions, key, positive, with_task = variant
    state = {"text": text, "task": "recall"} if with_task else {"text": text}
    res = agent.predict(state, questions)
    probs = res.get("answers", {}).get(key, {}).get("probabilities", {})
    return float(probs.get(positive, 0.0))


def metrics(scores: list[float], labels: list[bool], threshold: float) -> dict:
    tp = sum(1 for s, y in zip(scores, labels) if s >= threshold and y)
    fp = sum(1 for s, y in zip(scores, labels) if s >= threshold and not y)
    fn = sum(1 for s, y in zip(scores, labels) if s < threshold and y)
    tn = len(labels) - tp - fp - fn
    pos, neg = tp + fn, fp + tn
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / pos if pos else None
    f1 = 2 * precision * recall / (precision + recall) if precision and recall else 0.0
    return {"threshold": threshold, "tp": tp, "fp": fp, "fn": fn, "tn": tn,
            "fp_rate": fp / neg if neg else None, "recall": recall, "precision": precision,
            "f1": f1, "accuracy": (tp + tn) / len(labels)}


def pick_threshold(scores: list[float], labels: list[bool]) -> dict:
    """Highest recall with FP rate <= MAX_FP_RATE; else the best-F1 threshold."""
    candidates = sorted(set([round(s, 4) for s in scores] + [0.5]))
    results = [metrics(scores, labels, t) for t in candidates]
    ok = [m for m in results if m["fp_rate"] is not None and m["fp_rate"] <= MAX_FP_RATE and m["tp"] > 0]
    if ok:
        best = max(ok, key=lambda m: (m["recall"], m["precision"] or 0, -m["threshold"]))
        best["meets_fp_target"] = True
    else:
        best = max(results, key=lambda m: m["f1"])
        best["meets_fp_target"] = False
    return best


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", default="auto", choices=["auto", "mlx", "pytorch"])
    parser.add_argument("--model", default=None)
    parser.add_argument("--variants", default=",".join(VARIANTS), help="comma-separated variant names")
    parser.add_argument("--out", default=str(ROOT / "laya-tune-result.json"))
    args = parser.parse_args()

    tune, holdout = load_rows(TUNE), load_rows(HOLDOUT)
    t0 = time.perf_counter()
    agent, backend = load_agent(args.backend, args.model)
    load_ms = (time.perf_counter() - t0) * 1000
    print(f"backend={backend} model load {load_ms:.0f} ms; tune n={len(tune)}, holdout n={len(holdout)}; FP target <= {MAX_FP_RATE:.0%}")
    print(f"{'variant':22} {'thr':>5} | {'tune FP':>7} {'recall':>6} {'prec':>5} | {'HOLDOUT FP':>10} {'recall':>6} {'prec':>5} {'acc':>5} | {'ms':>5}")

    report = {"backend": backend, "loadMs": load_ms, "maxFpRate": MAX_FP_RATE, "variants": {}}
    pct = lambda v: "  n/a" if v is None else f"{v * 100:4.0f}%"
    for name in [v.strip() for v in args.variants.split(",") if v.strip()]:
        variant = VARIANTS[name]
        t = time.perf_counter()
        tune_scores = [score(agent, variant, r["text"]) for r in tune]
        hold_scores = [score(agent, variant, r["text"]) for r in holdout]
        per_call_ms = (time.perf_counter() - t) * 1000 / (len(tune) + len(holdout))
        chosen = pick_threshold(tune_scores, [r["recall"] for r in tune])
        hold = metrics(hold_scores, [r["recall"] for r in holdout], chosen["threshold"])
        report["variants"][name] = {
            "tune": chosen, "holdout": hold, "msPerCall": per_call_ms,
            "tuneScores": [{"text": r["text"], "recall": r["recall"], "score": s} for r, s in zip(tune, tune_scores)],
            "holdoutScores": [{"text": r["text"], "recall": r["recall"], "score": s} for r, s in zip(holdout, hold_scores)],
        }
        flag = "" if chosen["meets_fp_target"] else "  (no threshold meets FP target on tune; best F1 shown)"
        print(f"{name:22} {chosen['threshold']:5.2f} | {pct(chosen['fp_rate']):>7} {pct(chosen['recall']):>6} {pct(chosen['precision']):>5} | "
              f"{pct(hold['fp_rate']):>10} {pct(hold['recall']):>6} {pct(hold['precision']):>5} {pct(hold['accuracy']):>5} | {per_call_ms:5.1f}{flag}")

    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nFull per-prompt scores written to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
