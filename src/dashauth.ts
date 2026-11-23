/**
 * Password gate for /dashboard and /funnel.
 *
 * Off unless FUNNEL_KEY is set in the environment (Render → Environment). The password itself is
 * never in the repo, which is public. Signing in sets an HttpOnly cookie holding a hash of the
 * key (not the key), valid 30 days; ?key= in the URL still works for scripts. Changing FUNNEL_KEY
 * invalidates every cookie at once.
 */
import express, { Router, type Request, type Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";

const COOKIE = "x402dash";
const key = () => process.env.FUNNEL_KEY?.trim() || "";
const token = (k: string) => createHash("sha256").update(`${k}|x402-seller-dashboard`).digest("hex");

function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookie(req: Request, name: string): string {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

/** True when no password is configured, or the request carries a valid key or cookie. */
export function dashAuthed(req: Request): boolean {
  const k = key();
  if (!k) return true;
  return same(String(req.query.key ?? ""), k) || same(cookie(req, COOKIE), token(k));
}

export function loginPage(error = ""): string {
  const msg = error ? `<p class="err">${error}</p>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>x402-seller · Sign in</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100dvh;display:grid;place-items:center;background:#060708;color:#f3f4f2;font-family:Geist,system-ui,sans-serif;-webkit-font-smoothing:antialiased;padding:16px;
  background-image:radial-gradient(55vw 45vw at 85% -10%,rgba(126,226,168,.09),transparent 60%)}
.shell{width:100%;max-width:380px;padding:7px;border-radius:28px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.08);animation:in .9s cubic-bezier(.32,.72,0,1) both}
.core{border-radius:21px;background:linear-gradient(180deg,#111417,#0d0f11);box-shadow:inset 0 1px 0 rgba(255,255,255,.06);padding:32px 28px}
.brand{display:flex;align-items:center;gap:10px;font-weight:500;margin-bottom:28px}
.dot{width:18px;height:18px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#d9ffe9,#4fbf83 70%);box-shadow:0 0 0 3px rgba(126,226,168,.12)}
h1{font-size:26px;font-weight:500;letter-spacing:-.03em}
p.sub{color:rgba(243,244,242,.5);font-size:14px;margin:6px 0 24px}
input{width:100%;font:inherit;font-size:15px;color:#f3f4f2;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:14px 16px;outline:0;transition:border-color .5s cubic-bezier(.32,.72,0,1)}
input:focus{border-color:rgba(184,242,208,.4)}
button{margin-top:12px;width:100%;font:inherit;font-weight:500;font-size:14px;border:0;border-radius:999px;padding:14px;background:#f3f4f2;color:#0a0b0c;cursor:pointer;transition:transform .5s cubic-bezier(.32,.72,0,1)}
button:active{transform:scale(.98)}
.err{color:#ffb4aa;font-size:13px;margin:-8px 0 16px}
@keyframes in{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
</style></head><body>
<div class="shell"><div class="core">
<div class="brand"><span class="dot"></span>x402-seller</div>
<h1>Dashboard</h1><p class="sub">Enter the password to continue.</p>${msg}
<form method="post" action="/dashboard/login">
<input type="password" name="password" autocomplete="current-password" placeholder="Password" autofocus required aria-label="Password">
<button type="submit">Sign in</button>
</form></div></div></body></html>`;
}

export const dashAuthRouter: Router = Router();
dashAuthRouter.post("/dashboard/login", express.urlencoded({ extended: false, limit: "2kb" }), (req: Request, res: Response) => {
  const k = key();
  if (!k) return void res.redirect(303, "/dashboard");
  if (!same(String((req.body as any)?.password ?? ""), k)) {
    return void res.status(401).type("html").send(loginPage("That password is not right."));
  }
  res.setHeader("Set-Cookie", `${COOKIE}=${token(k)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
  res.redirect(303, "/dashboard");
});
dashAuthRouter.get("/dashboard/logout", (_req: Request, res: Response) => {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  res.redirect(303, "/dashboard");
});
