# Deploy: localhost → public HTTPS

This app is a plain Node/tsx Express server (`npm start` → `tsx src/index.ts`,
listens on `PORT`, default 4021). To get discovered (see BAZAAR.md) it needs a
public HTTPS URL. Ranked fastest → most durable.

---

## (a) cloudflared quick tunnel — zero account, ~30 seconds  ⭐ start here

Instant public HTTPS in front of your local server. No signup, no DNS.

```bash
brew install cloudflared                      # or: download the binary
npm start                                      # terminal 1: server on :4021
cloudflared tunnel --url http://localhost:4021 # terminal 2: prints a public URL
```

It prints `https://<random-words>.trycloudflare.com`. Verify it's really serving:
`curl -i https://<random>.trycloudflare.com/price?symbol=BTC` → expect `HTTP 402`.
Paste that base URL into x402scan's "Add API" form.

Limits (be honest about these):
- **URL is random and ephemeral** — it changes every restart and the tunnel dies
  when you close the terminal or reboot. Any directory listing goes stale.
- No SLA, rate-limited, meant for dev/demo. Fine to *get listed and tested*,
  not for a service you want agents to rely on.
- Your Mac must stay awake and running the server (M4 heat: this is light, no GPU).
- For a stable name, create a free named tunnel (Cloudflare account) later.

## (b) Render free tier — durable stable HTTPS URL

Gives a persistent `https://x402-seller.onrender.com`. Best "leave it running" option.

1. Push this repo to GitHub (confirm `.gitignore` excludes `wallet.json` + `.env` — it does).
2. Render → **New → Web Service** → connect the repo.
3. Environment **Node**; **Build**: `npm install`; **Start**: `npm start`.
4. Add env vars in the dashboard (NOT committed): `NETWORK`, `FACILITATOR_URL`,
   `PAY_TO`, and for mainnet the CDP keys. Render sets `PORT` itself — the code
   already reads `process.env.PORT`, so leave it unset.
5. Deploy. Verify: `curl -i https://<your>.onrender.com/price?symbol=BTC` → `HTTP 402`.

Limits: free tier **sleeps after ~15 min idle** (first request cold-starts ~30–60s).
An agent's first call may time out, then wake it. Fine for early discovery.
(Railway is equivalent: New Project → Deploy from repo → same build/start → set the
same env vars in its Variables tab → it assigns a public domain.)

## (c) Keep secrets out of the deploy — do this every path

`wallet.json` (private key) and `.env` are **already gitignored** — verify before
any push: `git check-ignore wallet.json .env` should print both.

- **Never commit `wallet.json` or `.env`.** Whoever has `wallet.json` controls the funds.
- On a PaaS, set config via the **dashboard env vars** (`PAY_TO`, `NETWORK`,
  `FACILITATOR_URL`, CDP keys) — do not bake them into the repo or the image.
- To *receive* USDC the server only needs the `PAY_TO` **address**, not a private key.
  Prefer deploying with only `PAY_TO` set and **no `wallet.json`** on the server, so
  no key ever leaves your machine. (`wallet.json` matters only when you move funds.)
- Rotate/replace the temporary receive address `0x39538F…9A51` with the owner's real
  Base address before going live.

---

**Recommendation:** use **(a) cloudflared quick tunnel** right now to get the URL,
verify the `402`, and submit to x402scan in the next few minutes — zero friction.
Then, before doing the Coinbase/mainnet path (which needs a *stable* URL for a real
settled payment), move to **(b) Render** for a persistent HTTPS endpoint that
survives reboots.
