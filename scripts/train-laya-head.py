"""Train the recall head: a small logistic-regression layer on top of the Laya encoder.

Laya's zero-shot question ("does this need project history?") cannot tell a general question from one
about this user's own work when both use the same words. A linear probe on the same encoder, trained
on labelled prompts, learns that distinction from examples instead of from hand-written keyword rules.

Features: the encoder's mean-pooled sentence embedding + the zero-shot memory-need score.
Model:    L2-regularised logistic regression (numpy only). The regularisation strength is picked by
          stratified k-fold cross-validation; the reported metrics are out-of-fold, so they are an
          honest estimate for prompts the head has not seen.
Output:   a JSON head the Laya service loads at start (see lib/laya-service/service.py).

Run (from the plugin folder):
  npm run laya:train                                   # bundled fixtures + ~/.laya/labels*.jsonl -> ~/.laya/recall-head.json
  npm run laya:train -- --data extra.jsonl --test blind.jsonl --out ~/.laya/recall-head.json

Everything runs locally; prompts never leave the machine and are not stored in the head.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures"
DEFAULT_DATA = [FIXTURES / f"laya-recall-{name}.jsonl" for name in ("eval", "holdout", "vault", "chat")]
LAYA_HOME = Path.home() / ".laya"
# Your own labelled prompts (real traffic): labels.jsonl from `npm run laya:label`, plus any other
# labels-*.jsonl you keep there. They are added to training and, because they have the real mix of
# prompts, used to pick the operating thresholds.
DEFAULT_OUT = ROOT / "lib" / "laya-service" / "recall-head.json"
HEAD_FORMAT = "laya-recall-head"
HEAD_VERSION = 1
MAX_LENGTH = 128
C_GRID = (0.03, 0.1, 0.3, 1.0, 3.0, 10.0)
# The router skips memory below skipThreshold. Keep prompts that needed memory from being skipped.
MAX_WRONG_SKIP = 0.05
ROUTER_RECALL_THRESHOLD = 0.5
ROUTER_SKIP_THRESHOLD = 0.35

sys.path.insert(0, str(ROOT / "lib" / "laya-service"))
from service import MEMORY_NEED_QUESTION  # noqa: E402  (same zero-shot question the service asks)


TRAIN_LABELS = ("recall", "none")


def label_of(item: dict):
    """recall / capture / none / context; legacy rows only have the boolean `recall`."""
    label = item.get("label")
    if label in ("recall", "capture", "none", "context"):
        return label
    return ("recall" if item["recall"] else "none") if isinstance(item.get("recall"), bool) else None


def load_rows(paths, skipped: dict | None = None) -> list[dict]:
    """Rows for the head. It answers one question, "should the agent look something up first?", so
    capture requests (write, not read) and context rows (undecidable from the prompt alone) are left out."""
    rows, seen = [], set()
    for path in paths:
        path = Path(path).expanduser()
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            item = json.loads(line)
            text = item.get("text")
            label = label_of(item)
            if not isinstance(text, str) or not text.strip() or label is None:
                continue
            key = " ".join(text.split())
            if key in seen:
                continue
            seen.add(key)
            if label not in TRAIN_LABELS:
                if skipped is not None:
                    skipped[label] = skipped.get(label, 0) + 1
                continue
            rows.append({"text": text, "recall": label == "recall", "source": path.name})
    return rows


def load_agent(backend: str, model: str | None):
    if backend == "auto":
        backend = "mlx" if sys.platform == "darwin" else "pytorch"
    if backend == "mlx":
        import laya_mlx
        model = model or "aac6fef/laya-multilingual-mlx"
        agent = laya_mlx.load(model)
        return agent, laya_mlx.embed_fn_from_agent(agent, max_length=MAX_LENGTH), backend, model
    import laya
    model = model or "convaiinnovations/laya-multilingual"
    agent = laya.load(model)
    return agent, laya.embed_fn_from_agent(agent, max_length=MAX_LENGTH), backend, model


def featurize(agent, embed, texts: list[str]) -> np.ndarray:
    emb = np.asarray(embed(texts), dtype=np.float64)
    emb /= np.maximum(np.linalg.norm(emb, axis=1, keepdims=True), 1e-9)
    need = np.array([
        float(agent.predict({"text": t}, {"memory_need": MEMORY_NEED_QUESTION})
              .get("answers", {}).get("memory_need", {}).get("probabilities", {}).get("project_history", 0.0))
        for t in texts
    ])
    return np.hstack([emb, need[:, None]])


def sigmoid(z):
    return 1.0 / (1.0 + np.exp(-np.clip(z, -30, 30)))


def fit(X: np.ndarray, y: np.ndarray, C: float, iters: int = 400):
    """L2 logistic regression with class balancing, full-batch gradient descent with a line search-free
    Adam step. Returns (mean, std, weights, bias)."""
    mean, std = X.mean(axis=0), X.std(axis=0) + 1e-6
    Z = (X - mean) / std
    n, d = Z.shape
    pos = max(1, int(y.sum()))
    neg = max(1, n - pos)
    sw = np.where(y == 1, n / (2 * pos), n / (2 * neg))
    w, b = np.zeros(d), 0.0
    m_w, v_w, m_b, v_b = np.zeros(d), np.zeros(d), 0.0, 0.0
    lr, b1, b2, eps = 0.05, 0.9, 0.999, 1e-8
    lam = 1.0 / (C * n)
    for t in range(1, iters + 1):
        p = sigmoid(Z @ w + b)
        g = sw * (p - y) / n
        gw = Z.T @ g + lam * w
        gb = g.sum()
        m_w = b1 * m_w + (1 - b1) * gw
        v_w = b2 * v_w + (1 - b2) * gw * gw
        m_b = b1 * m_b + (1 - b1) * gb
        v_b = b2 * v_b + (1 - b2) * gb * gb
        w -= lr * (m_w / (1 - b1 ** t)) / (np.sqrt(v_w / (1 - b2 ** t)) + eps)
        b -= lr * (m_b / (1 - b1 ** t)) / (math.sqrt(v_b / (1 - b2 ** t)) + eps)
    return mean, std, w, b


def predict(model, X):
    mean, std, w, b = model
    return sigmoid(((X - mean) / std) @ w + b)


def folds(y: np.ndarray, k: int, seed: int = 7):
    rng = np.random.default_rng(seed)
    assign = np.empty(len(y), dtype=int)
    for label in (0, 1):
        idx = np.flatnonzero(y == label)
        rng.shuffle(idx)
        assign[idx] = np.arange(len(idx)) % k
    return [(np.flatnonzero(assign != i), np.flatnonzero(assign == i)) for i in range(k)]


def metrics(p: np.ndarray, y: np.ndarray, threshold: float, skip: float | None = None) -> dict:
    pred = p >= threshold
    tp = int((pred & (y == 1)).sum()); fp = int((pred & (y == 0)).sum())
    fn = int((~pred & (y == 1)).sum()); tn = len(y) - tp - fp - fn
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    out = {"n": int(len(y)), "threshold": round(float(threshold), 4), "precision": precision, "recall": recall,
           "f1": 2 * precision * recall / (precision + recall) if precision and recall else 0.0,
           "accuracy": (tp + tn) / len(y) if len(y) else 0.0, "tp": tp, "fp": fp, "fn": fn, "tn": tn}
    if skip is not None:
        skipped = p < skip
        out["skipThreshold"] = round(float(skip), 4)
        out["wrongSkipRate"] = float((skipped & (y == 1)).sum() / max(1, (y == 1).sum()))
        out["negativesSkipped"] = float((skipped & (y == 0)).sum() / max(1, (y == 0).sum()))
    return out


def oof_scores(X, y, C, k):
    p = np.zeros(len(y))
    for train, test in folds(y, k):
        p[test] = predict(fit(X[train], y[train], C), X[test])
    return p


def logit(v: float) -> float:
    v = min(max(v, 1e-6), 1 - 1e-6)
    return math.log(v / (1 - v))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", action="append", help="labelled JSONL (repeatable); default: bundled fixtures")
    parser.add_argument("--labels", default=str(LAYA_HOME), help="directory with your labels*.jsonl (added if present; '' to skip)")
    parser.add_argument("--test", action="append", help="blind JSONL scored once with the final head (never used for fitting)")
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--backend", default="auto", choices=["auto", "mlx", "pytorch"])
    parser.add_argument("--model", default=None)
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--calibrate-on", default=None, help="file name of a --data source with the real prompt mix; operating points are chosen on its out-of-fold scores")
    parser.add_argument("--dump-oof", default=None, help="write out-of-fold scores per prompt (JSONL) for offline end-to-end analysis")
    parser.add_argument("--dry-run", action="store_true", help="report cross-validation only; do not write the head")
    args = parser.parse_args()

    label_files = sorted(Path(args.labels).expanduser().glob("labels*.jsonl")) if args.labels else []
    sources = list(args.data or DEFAULT_DATA) + label_files
    skipped: dict = {}
    rows = load_rows(sources, skipped)
    if skipped:
        print("left out (not a look-up question): " + ", ".join(f"{k} {v}" for k, v in sorted(skipped.items())))
    real_mix = [f.name for f in label_files if any(r["source"] == f.name for r in rows)]
    if not args.calibrate_on and real_mix:
        args.calibrate_on = real_mix
    test_rows = load_rows(args.test or [])
    train_keys = {" ".join(r["text"].split()) for r in rows}
    test_rows = [r for r in test_rows if " ".join(r["text"].split()) not in train_keys]
    y = np.array([1 if r["recall"] else 0 for r in rows])
    if len(rows) < 40 or y.sum() < 10 or (1 - y).sum() < 10:
        print(f"Need at least 40 labelled prompts with 10 of each label; have {len(rows)}.")
        return 2

    t0 = time.perf_counter()
    agent, embed, backend, model_id = load_agent(args.backend, args.model)
    X = featurize(agent, embed, [r["text"] for r in rows])
    print(f"backend={backend} model={model_id}; {len(rows)} labelled prompts ({int(y.sum())} need memory) "
          f"embedded in {time.perf_counter() - t0:.1f}s, dim={X.shape[1]}")

    # Zero-shot baseline on the same rows, for comparison.
    zero_shot = X[:, -1]
    print(f"zero-shot Laya score @0.5  : " + fmt(metrics(zero_shot, y, 0.5, ROUTER_SKIP_THRESHOLD)))

    best = None
    for C in C_GRID:
        p = oof_scores(X, y, C, args.folds)
        m = metrics(p, y, 0.5)
        print(f"C={C:<5} out-of-fold @0.5 : " + fmt(m))
        if best is None or m["f1"] > best[1]["f1"]:
            best = (C, m, p)
    C, _, p = best

    # Operating points from out-of-fold scores: the recall threshold that maximises F1, and the highest
    # skip threshold that wrongly skips at most MAX_WRONG_SKIP of the prompts that needed memory.
    # Labelled sets are usually richer in positives than real traffic; --calibrate-on picks the points on
    # the source that has the real mix.
    sources_arr = np.array([r["source"] for r in rows])
    cal_names = args.calibrate_on if isinstance(args.calibrate_on, list) else ([Path(args.calibrate_on).name] if args.calibrate_on else [])
    cal = np.isin(sources_arr, cal_names) if cal_names else np.ones(len(rows), dtype=bool)
    print(f"operating points chosen on: {', '.join(cal_names) if cal_names else 'all labelled prompts'}")
    if cal.sum() < 20 or y[cal].sum() < 3:
        cal = np.ones(len(rows), dtype=bool)
    pc, yc = p[cal], y[cal]
    grid = np.linspace(0.05, 0.95, 91)
    recall_thr = max(grid, key=lambda t: (metrics(pc, yc, t)["f1"], -abs(t - 0.5)))
    skip_ok = [t for t in grid if t <= recall_thr and metrics(pc, yc, recall_thr, t)["wrongSkipRate"] <= MAX_WRONG_SKIP]
    skip_thr = max(skip_ok) if skip_ok else 0.05
    print(f"\nchosen C={C}; out-of-fold at recall>={recall_thr:.2f}, skip<{skip_thr:.2f}: " + fmt(metrics(p, y, recall_thr, skip_thr)))
    for source in sorted(set(sources_arr)):
        mask = sources_arr == source
        print(f"  {source:34} " + fmt(metrics(p[mask], y[mask], recall_thr, skip_thr)) + f"  (n={int(mask.sum())}, need={int(y[mask].sum())})")

    if args.dump_oof:
        with Path(args.dump_oof).expanduser().open("w", encoding="utf-8") as fh:
            for r, score_oof, zs in zip(rows, p, X[:, -1]):
                fh.write(json.dumps({"text": r["text"], "recall": r["recall"], "source": r["source"], "oof": float(score_oof), "zeroShot": float(zs),
                                     "recallThreshold": float(recall_thr), "skipThreshold": float(skip_thr)}, ensure_ascii=False) + "\n")

    final = fit(X, y, C)
    mean, std, w, b = final
    # Fold the chosen operating points into the head so the router's default thresholds apply unchanged:
    # a monotone piecewise-linear map in logit space sends skip_thr -> 0.35 and recall_thr -> 0.5.
    calib = {"skip": [logit(skip_thr), logit(ROUTER_SKIP_THRESHOLD)], "recall": [logit(recall_thr), logit(ROUTER_RECALL_THRESHOLD)]}

    report = {"C": C, "folds": args.folds, "outOfFold": metrics(p, y, recall_thr, skip_thr), "zeroShot": metrics(zero_shot, y, 0.5, ROUTER_SKIP_THRESHOLD)}
    if test_rows:
        yt = np.array([1 if r["recall"] else 0 for r in test_rows])
        Xt = featurize(agent, embed, [r["text"] for r in test_rows])
        pt = predict(final, Xt)
        report["blindTest"] = metrics(pt, yt, recall_thr, skip_thr)
        report["blindZeroShot"] = metrics(Xt[:, -1], yt, 0.5, ROUTER_SKIP_THRESHOLD)
        print(f"\nBLIND TEST ({len(test_rows)} prompts never used for fitting)")
        print(f"  zero-shot Laya @0.5   : " + fmt(report["blindZeroShot"]))
        print(f"  trained head          : " + fmt(report["blindTest"]))

    if args.dry_run:
        return 0
    head = {
        "format": HEAD_FORMAT,
        "version": HEAD_VERSION,
        "model": model_id,
        "maxLength": MAX_LENGTH,
        "features": ["embedding_mean_l2", "memory_need"],
        "mean": [round(float(v), 6) for v in mean],
        "std": [round(float(v), 6) for v in std],
        "weights": [round(float(v), 6) for v in w],
        "bias": round(float(b), 6),
        "calibration": calib,
        "trainedAt": time.strftime("%Y-%m-%d"),
        "trainedOn": {"prompts": len(rows), "needMemory": int(y.sum()), "sources": sorted({r["source"] for r in rows})},
        "report": report,
    }
    out = Path(args.out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(head, ensure_ascii=False) + "\n", encoding="utf-8")
    if LAYA_HOME in out.resolve().parents:
        out.chmod(0o600)  # like the other files under ~/.laya
    print(f"\nHead written to {out} (restart Laya to load it: laya stop && laya start)")
    return 0


def fmt(m: dict) -> str:
    s = f"P {m['precision'] * 100:5.1f}  R {m['recall'] * 100:5.1f}  F1 {m['f1'] * 100:5.1f}  acc {m['accuracy'] * 100:5.1f}"
    if "wrongSkipRate" in m:
        s += f"  wrong-skip {m['wrongSkipRate'] * 100:4.1f}%  negatives-skipped {m['negativesSkipped'] * 100:4.1f}%"
    return s


if __name__ == "__main__":
    sys.exit(main())
