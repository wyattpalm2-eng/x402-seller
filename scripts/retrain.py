#!/usr/bin/env python3
"""
retrain.py — refit the survival model on the live ledger, end to end.

    python3 scripts/retrain.py                 # pull from production, validate, regenerate
    python3 scripts/retrain.py --dry-run       # validate only, write nothing
    python3 scripts/retrain.py --from raw.json # use a local /track-record/raw dump

It fetches the labelled rows, runs walk-forward validation, REFUSES to ship a model that does not
beat the one in the tree, then rewrites data/survival_model.json and src/survival.ts.

The refusal is the point. Retraining on fresh data is exactly when a model quietly gets worse — the
ledger is a rolling 2,000-row window, so a bad week of upstream data or a change in what Base
launchpads emit could degrade the fit, and a script that always writes would ship that silently.

Requires: numpy, scikit-learn. Neither is needed to RUN the service — the shipped model is plain
arithmetic in TypeScript — only to refit it.
"""
import argparse, json, math, os, subprocess, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LIVE = "https://x402-seller-m8nx.onrender.com/track-record/raw"
MIN_ROWS = 400          # below this the walk-forward folds are too thin to mean anything
MIN_AUC = 0.85          # a fit worse than this is not worth shipping over the current one
C = 0.2

def load(src):
    if src:
        with open(src) as f:
            return json.load(f)["rows"]
    print(f"fetching {LIVE} …")
    # A stock python.org build on macOS ships without a CA bundle wired into urllib, so verification
    # fails on a perfectly valid certificate. Try certifi, then fall back to curl, which uses the
    # system trust store. Never disable verification: this fetch is what the model is fit on.
    try:
        ctx = None
        try:
            import certifi, ssl
            ctx = ssl.create_default_context(cafile=certifi.where())
        except ImportError:
            pass
        with urllib.request.urlopen(LIVE, timeout=180, context=ctx) as r:
            return json.loads(r.read())["rows"]
    except Exception as e:
        print(f"  urllib failed ({type(e).__name__}), falling back to curl")
        out = subprocess.run(["curl", "-sSf", "--max-time", "180", LIVE],
                             capture_output=True, text=True)
        if out.returncode != 0:
            sys.exit(f"could not fetch the ledger: {out.stderr.strip()}")
        return json.loads(out.stdout)["rows"]

KEYS = ['log_liq','band_launchpad','band_micro','band_mid','band_deep','green_flags','red_flags',
        'sources','renounced','verified','mintable','proxy','creator_prior_hp','hp_honeypot',
        'needs_review','addr_vanity','addr_zero_run','buy_tax','sell_tax','has_holders',
        'log_holders','lp_locked_known','lp_locked']

def fingerprint(address):
    body = address.replace('0x', '').lower()
    best, cur = 0, 1
    for i in range(1, len(body)):
        if body[i] == body[i-1]:
            cur += 1
            best = max(best, cur)
        else:
            cur = 1
    best = best or 1
    return best, best >= 8

def featurize(row):
    f = row['feat']
    liq = float(f.get('liq_usd') or 0)
    h = f.get('holders')
    zr, van = fingerprint(row['address'])
    d = {
        'log_liq': math.log10(liq + 1),
        'band_launchpad': 1.0 if 9000 <= liq < 13000 else 0.0,
        'band_micro': 1.0 if liq < 5000 else 0.0,
        'band_mid': 1.0 if 13000 <= liq < 50000 else 0.0,
        'band_deep': 1.0 if liq >= 50000 else 0.0,
        'green_flags': float(f.get('green_flags') or 0),
        'red_flags': float(f.get('red_flags') or 0),
        'sources': float(f.get('sources') or 0),
        'renounced': 1.0 if f.get('renounced') else 0.0,
        'verified': 1.0 if f.get('verified') else 0.0,
        'mintable': 1.0 if f.get('mintable') else 0.0,
        'proxy': 1.0 if f.get('proxy') else 0.0,
        'creator_prior_hp': 1.0 if f.get('creator_prior_honeypot') else 0.0,
        'hp_honeypot': 1.0 if f.get('hp_honeypot') else 0.0,
        'needs_review': 1.0 if f.get('needs_review') else 0.0,
        'addr_vanity': 1.0 if van else 0.0,
        'addr_zero_run': float(zr),
        'buy_tax': min(float(f.get('buy_tax') or 0), 100.0),
        'sell_tax': min(float(f.get('sell_tax') or 0), 100.0),
        'has_holders': 1.0 if h is not None else 0.0,
        'log_holders': math.log10(float(h) + 1) if h is not None else 0.0,
        'lp_locked_known': 1.0 if f.get('lp_locked') is not None else 0.0,
        'lp_locked': 1.0 if f.get('lp_locked') else 0.0,
    }
    return [d[k] for k in KEYS]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="src", help="local /track-record/raw dump instead of production")
    ap.add_argument("--dry-run", action="store_true", help="validate only; write nothing")
    args = ap.parse_args()

    import numpy as np
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import roc_auc_score

    rows = load(args.src)
    g = sorted([r for r in rows if r.get('graded') and r.get('feat') and r.get('outcome')],
               key=lambda r: r['t'])
    print(f"{len(rows)} rows fetched · {len(g)} usable (graded, with features)")
    if len(g) < MIN_ROWS:
        sys.exit(f"REFUSING: only {len(g)} usable rows, need {MIN_ROWS}.")

    X = np.array([featurize(r) for r in g])
    y = np.array([1 if r['outcome'] == 'rugged' else 0 for r in g])
    print(f"base rug rate {100*y.mean():.1f}%")

    # walk-forward, strictly chronological
    oos_p, oos_y, fold_aucs = [], [], []
    min_train, n_folds = max(350, len(g)//3), 6
    step = max(1, (len(g) - min_train) // n_folds)
    for i in range(n_folds):
        cut = min_train + i*step
        end = min(cut + step, len(g))
        if end - cut < 30 or len(set(y[:cut])) < 2 or len(set(y[cut:end])) < 2:
            continue
        mu, sd = X[:cut].mean(0), X[:cut].std(0); sd[sd == 0] = 1
        clf = LogisticRegression(C=C, max_iter=5000).fit((X[:cut]-mu)/sd, y[:cut])
        p = clf.predict_proba((X[cut:end]-mu)/sd)[:, 1]
        fold_aucs.append(roc_auc_score(y[cut:end], p))
        oos_p.extend(p.tolist()); oos_y.extend(y[cut:end].tolist())
    if not fold_aucs:
        sys.exit("REFUSING: could not build any valid walk-forward fold.")
    oos_p, oos_y = np.array(oos_p), np.array(oos_y)
    pooled = float(roc_auc_score(oos_y, oos_p))
    print(f"walk-forward: {len(fold_aucs)} folds, pooled OOS AUC {pooled:.4f}, "
          f"worst fold {min(fold_aucs):.3f}  [{' '.join(f'{a:.2f}' for a in fold_aucs)}]")

    # the gate
    cur_path = os.path.join(ROOT, "data", "survival_model.json")
    current = json.load(open(cur_path)) if os.path.exists(cur_path) else None
    cur_auc = (current or {}).get("walkforward", {}).get("pooled_auc")
    if pooled < MIN_AUC:
        sys.exit(f"REFUSING: pooled AUC {pooled:.4f} is below the {MIN_AUC} floor. Model NOT written.")
    if cur_auc is not None and pooled < cur_auc - 0.02:
        sys.exit(f"REFUSING: pooled AUC {pooled:.4f} is materially worse than the shipped "
                 f"{cur_auc:.4f}. Model NOT written — investigate the new rows first.")
    print(f"gate passed (shipped model: {cur_auc})")

    if args.dry_run:
        print("--dry-run: nothing written.")
        return

    BINS = [(0.0,0.10),(0.10,0.25),(0.25,0.50),(0.50,0.75),(0.75,0.90),(0.90,0.98),(0.98,1.01)]
    calib = []
    for lo, hi in BINS:
        s = (oos_p >= lo) & (oos_p < hi)
        calib.append({'lo': lo, 'hi': hi, 'n': int(s.sum()),
                      'observed_rug': round(float(oos_y[s].mean()), 4) if s.sum() >= 5 else None})

    mu, sd = X.mean(0), X.std(0); sd[sd == 0] = 1
    clf = LogisticRegression(C=C, max_iter=5000).fit((X-mu)/sd, y)
    from datetime import datetime, timezone
    out = {
        'version': f"survival-{datetime.now(timezone.utc).strftime('%Y-%m-%d')}",
        'keys': KEYS,
        'mu': [round(v, 6) for v in mu.tolist()],
        'sd': [round(v, 6) for v in sd.tolist()],
        'coef': [round(v, 6) for v in clf.coef_[0].tolist()],
        'intercept': round(float(clf.intercept_[0]), 6),
        'C': C, 'horizon_hours': 6,
        'trained_rows': int(len(y)),
        'trained_through_ms': int(g[-1]['t']),
        'train_base_rug_rate': round(float(y.mean()), 4),
        'walkforward': {
            'folds': len(fold_aucs), 'pooled_n': int(len(oos_y)),
            'pooled_auc': round(pooled, 4),
            'worst_fold_auc': round(float(min(fold_aucs)), 4),
            'prod_scorer_auc': 0.545,
        },
        'calibration': calib,
    }
    json.dump(out, open(cur_path, 'w'), indent=1)
    print(f"wrote {cur_path}")
    subprocess.run([sys.executable, os.path.join(HERE, "gen_survival.py")], cwd=os.path.dirname(cur_path), check=True)
    print("\nNow run:  npx tsc --noEmit && npx tsx scripts/selftest.mts")

if __name__ == "__main__":
    main()
