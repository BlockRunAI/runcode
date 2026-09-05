<div align="center">

<br>

<img src="assets/terminal-banner.png" alt="Franklin Agent terminal" width="680">

<br><br>

<h1>Franklin Agent</h1>
<h3>The AI agent with a wallet.</h3>

<p>
  Other agents just talk. Franklin Agent holds your USDC <em>and puts it to work</em> —<br>
  trading, research, and autonomous tasks with real budgets, real guardrails, real outcomes.<br>
  One wallet. Every model. Every paid API. Pay only for outcomes — not subscriptions.
</p>

<p>
  <a href="https://npmjs.com/package/@blockrun/franklin"><img src="https://img.shields.io/npm/v/@blockrun/franklin.svg?style=flat-square&color=FFD700&label=npm" alt="npm"></a>
  <a href="https://npmjs.com/package/@blockrun/franklin"><img src="https://img.shields.io/npm/dm/@blockrun/franklin.svg?style=flat-square&color=10B981&label=downloads" alt="downloads"></a>
  <a href="https://github.com/BlockRunAI/Franklin/stargazers"><img src="https://img.shields.io/github/stars/BlockRunAI/Franklin?style=flat-square&color=FFD700&label=stars" alt="stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache_2.0-blue?style=flat-square" alt="license"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node-%E2%89%A520-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node"></a>
  <a href="https://x402.org"><img src="https://img.shields.io/badge/x402-native-10B981?style=flat-square" alt="x402"></a>
  <a href="https://t.me/blockrunAI"><img src="https://img.shields.io/badge/chat-telegram-26A5E4?style=flat-square&logo=telegram&logoColor=white" alt="telegram"></a>
</p>

<p>
  <a href="#quick-start">Quick&nbsp;start</a> ·
  <a href="#two-ways-to-pay">Two&nbsp;ways&nbsp;to&nbsp;pay</a> ·
  <a href="#franklin-desktop-beta">Desktop</a> ·
  <a href="#yopo">YOPO</a> ·
  <a href="#a-new-category">Category</a> ·
  <a href="#what-franklin-can-execute">What&nbsp;it&nbsp;does</a> ·
  <a href="#smart-router">Smart&nbsp;Router</a> ·
  <a href="#the-comparison">Comparison</a> ·
  <a href="#how-it-works">Architecture</a> ·
  <a href="#community">Community</a>
</p>

</div>

---

## The pitch in one paragraph

Franklin Agent is an **autonomous economic agent** — an AI that holds a USDC wallet and spends it to get real work done, with **trading as its flagship arena**. It buys live market data, proposes trade plans you approve before a cent moves, pursues long-running goals across sessions, keeps a wallet-bound trading journal, and picks the best model per task from 55+ providers. You state an outcome and set a budget. Franklin Agent decides what to call, what to pay for, and when to stop. No subscriptions, no seats, no rate limits.

Funding it is your choice. Fund a **USDC wallet** and every paid action routes through the [x402](https://x402.org) micropayment protocol, settling on-chain against a wallet only you control — no signup, no account, the wallet is the identity. Or top up a **prepaid balance** at [user.blockrun.ai](https://user.blockrun.ai) and hand Franklin an API key. Same models, same tools, same agent. See [Two ways to pay](#two-ways-to-pay).

Built by the [BlockRun](https://blockrun.ai) team. Apache-2.0. TypeScript. Ships as one npm package.

> **YOPO — You Only Pay Outcome**
>
> Not a subscription (pay for access). Not a generic pay-per-call (pay for trying).
> You pay only for the work Franklin Agent delivers. Provider cost + 5%, settled per action
> in USDC. No monthly fees. No rate limits. No overdraft.

---

## Quick start

> **Requires Node.js 20.19+ (Node 22 LTS recommended).** Check with `node -v`. Older Node crashes at startup with `ERR_REQUIRE_ESM`.

```bash
# 1. Install
npm install -g @blockrun/franklin

# 2. Run (free — uses NVIDIA Nemotron & Qwen3 Coder out of the box)
franklin

# 3. (optional) Unlock Sonnet, Opus, GPT, Gemini, Grok + every paid API.
#    Pick ONE — a USDC wallet, or a prepaid API key.

#    a) Wallet — no signup, no account
franklin setup solana      # or: franklin setup base
franklin balance           # show address + USDC balance

#    b) API key — sign up and top up at https://user.blockrun.ai
franklin login brk_live_...
```

Either route unlocks the same thing: **$5** buys you every frontier model and every paid tool in the BlockRun gateway. The wallet route needs zero signup, zero credit card, zero phone verification. The key route needs an account but no crypto.

**No global install? Just run it directly** — no permissions, no `-g`:

```bash
npx @blockrun/franklin
```

### Install troubleshooting

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| `npm error EACCES … mkdir '/usr/local/lib/node_modules'` | Your global npm folder is owned by root (common when Node was installed from the macOS `.pkg`). | Don't use `sudo`. Either run `npx @blockrun/franklin` (no global install needed), or switch to a user-owned Node via a version manager — see below. |
| `Error [ERR_REQUIRE_ESM] … rpc-websockets … require() of ES Module … uuid` | Node is older than 20.19. Franklin's Solana deps need the `require(esm)` support added in Node 20.19.0. | Upgrade to Node 20.19+ or 22 LTS (see below). This is the #1 cause of a crash on first run. |
| `npm warn EBADENGINE … required: { node: '>=20.x' }` | Node is older than 20.19. | Upgrade to Node 20.19+ or 22 LTS. The warning alone is harmless, but on old Node the run will also crash — upgrade. |

The clean, permanent fix for both is a **user-owned Node** so global installs never touch root-owned system folders:

```bash
# nvm (https://github.com/nvm-sh/nvm)
nvm install 22 && nvm use 22
npm install -g @blockrun/franklin

# or fnm (https://github.com/Schniz/fnm)
fnm install 22 && fnm use 22
npm install -g @blockrun/franklin
```

### Prefer a GUI? Try Franklin for VS Code

[![Franklin for VS Code — Beta is here](assets/franklin-vscode-banner.png)](https://marketplace.visualstudio.com/items?itemName=blockrun.franklin-vscode)

The same agent ships as a [VS Code extension](https://marketplace.visualstudio.com/items?itemName=blockrun.franklin-vscode) — chat panel, model picker, wallet balance, image / video generation, inline diff cards — all driven by the wallet you already funded for the CLI.

```
VS Code → Extensions  (Cmd+Shift+X / Ctrl+Shift+X)
        → search "Franklin" → Install
        → click the Franklin icon in the Activity Bar
```

Free models work immediately. Paid models, image gen, and video gen use your selected payment method: funded API account credit or a USDC wallet. The CLI and the extension share the same `~/.blockrun/` config and session history, so jumping between terminal and VS Code is seamless.

### Franklin Desktop (Beta)

Franklin Desktop brings the real Franklin agent into a native workspace for macOS
and Windows. It uses the same local wallet, models, tools, and session runtime as
the CLI, with a visual chat, conversation history, gallery, wallet, tools, skills,
and CLI panels.

| Platform | Current beta package |
| -------- | -------------------- |
| macOS (Apple silicon) | Unsigned `.dmg` test build |
| Windows (x64) | Unsigned `.exe` test build |

> **Beta distribution:** signed public downloads and automatic updates are not
> live yet. Maintainers can download the short-lived unsigned installers from
> [Desktop CI](https://github.com/BlockRunAI/Franklin/actions/workflows/desktop-ci.yml).
> Public signed builds will appear on the
> [Franklin releases page](https://github.com/BlockRunAI/Franklin/releases).

Desktop is local-first: it opens in `Documents/Franklin`, keeps session history
local by default, and asks before an agent accesses files outside the active
workspace. External files are not blocked; each access requires explicit approval.
Shell commands also require approval in the current beta.

The stable beta currently runs the Franklin agent. Team Mode and Studio adapters
for additional agent CLIs are being developed separately and are not included in
this release. See the [Desktop guide](apps/desktop/README.md) for development and
packaging instructions.

---

## Two ways to pay

Franklin needs money to work — it buys model calls, market data, search and media
generation on your behalf. There are two ways to give it that money, and they are
interchangeable. Everything else about the agent is identical.

| | **USDC wallet** (x402) | **API key** (prepaid credit) |
| --- | --- | --- |
| Setup | `franklin setup solana` | Sign up, top up, `franklin login brk_...` |
| Account required | No | Yes |
| Crypto required | Yes — USDC on Solana or Base | No — top up with a card |
| Settlement | On-chain, per call, via [x402](https://x402.org) | Against a prepaid balance |
| Gateway | `sol.blockrun.ai` / `blockrun.ai` | `api.blockrun.ai` |
| Where the money lives | A wallet only you hold the key to | Your BlockRun account |
| Spend visibility | `franklin stats` — exact settled amounts | `franklin balance` + [dashboard](https://user.blockrun.ai/dashboard); exact except chat |

**The wallet is still Franklin's identity.** Memory, the trading journal and goals are
keyed to it, and the wallet route is the one that needs nothing from us — no signup, no
KYC, no account to suspend. The API key exists because not everyone wants to hold crypto
to try an agent.

### Getting an API key

1. Sign up at **[user.blockrun.ai](https://user.blockrun.ai)**.
2. Top up your balance from the dashboard.
3. Create a key — it looks like `brk_live_...`.
4. Give it to Franklin:

```bash
franklin login brk_live_...     # verifies the key, then stores it at ~/.blockrun/api-key (0600)
franklin login                  # show the active pay mode without changing it
franklin logout                 # remove the key and fall back to the wallet
```

Or set it in the environment instead, which takes precedence over the stored key and is
the right choice for CI and servers:

```bash
export BLOCKRUN_API_KEY=brk_live_...
```

### Running both

You can have a wallet **and** a key configured at once. The key wins by default. To spend
from the wallet for a single run, add `--wallet` to any command:

```bash
franklin --wallet                 # this session pays from the wallet
franklin balance --wallet         # show the wallet balance, not the key status
```

If the key is rejected, or a tool needs an endpoint the key gateway does not serve,
Franklin returns that API error without charging a wallet. Correct the key or explicitly
retry with `--wallet`. An empty or malformed configured key is an error; remove it to
return to the wallet default. `franklin logout` removes the saved key; if
`BLOCKRUN_API_KEY` is exported, unset it too.

### Spend tracking, and the one thing that stays an estimate

In wallet mode every charge is exact: the gateway states the price in the x402 handshake
and Franklin records the amount that actually settled.

In API-key mode most calls now report what they cost. The gateway returns an
`x-blockrun-cost-usd` header on the pre-priced service families — search, images, RPC,
market data, phone, sandboxes — and Franklin records that figure exactly.

**Chat is the exception, permanently.** Chat settles *after* the answer is on the wire, so
a slow settlement never becomes a slow answer, which means the amount does not exist yet
when the headers are written. Franklin reconstructs chat spend from token counts and the
published rate, so chat rows are estimates. `franklin stats` marks estimated totals with
`~` and reports the estimated portion separately, so you can always see which is which.

`franklin balance` reads your real credit standing from the gateway:

```
Account:   acme (gated)
Remaining: $41.9980 of $50.00 granted
Spent:     $8.0020  (BlockRun, authoritative)
Local:     ~$8.0431  (Franklin's own tally, all time, both pay modes — expected to differ)
```

The two numbers differ on purpose: Franklin's tally covers both pay modes and estimates
chat, while BlockRun's is what you were actually billed. For the full per-call history,
use the [dashboard](https://user.blockrun.ai/dashboard).

---

## YOPO

**You Only Pay Outcome.** This is Franklin Agent's pricing model, and it is the opposite of almost every other AI product you use.

|                         | You pay for...                               | Result                               |
| ----------------------- | -------------------------------------------- | ------------------------------------ |
| AI subscription       | Access. Paid whether you use it or not. | $20–200/month, rate-limited.         |
| Pay-per-call (OpenAI API, etc.) | Every attempt — even failed ones.    | Hidden cost from retries, dead ends. |
| **Franklin Agent (YOPO)**     | **The outcome.** Each signed micropayment.  | **Provider cost + 5%. No more.**     |

Three consequences fall out of this:

1. **No subscriptions.** Use Franklin for $0.50 one week and $50 the next — you pay for compute actually consumed, nothing more.
2. **No rate limits.** Subscriptions throttle you when you need AI most. YOPO has no artificial caps — if you have USDC, you have access.
3. **No overdraft.** The wallet balance IS the hard limit. When it's empty, Franklin stops. No surprise bills, no 3 a.m. rate-limit walls.

Concretely — $1 in USDC gets you roughly:
- ~400K GPT-4o input tokens
- ~7M DeepSeek tokens
- ~13M Gemini Flash tokens
- ~20 DALL-E 3 images
- ~40 Exa neural web searches
- Unlimited agent-tested NVIDIA free tier (Qwen3 Coder + Llama 4 Maverick, no wallet needed)

---

## A new category

> **Economic Agent**
>
> Software that can hold a wallet, price its own actions, spend toward an outcome, and stop at a hard budget cap.

Most AI products fit into one of three buckets: they answer questions, write code, or automate a fixed workflow. None of them can spend money.

Franklin can. It combines **purchasing power** (it pays for models, tools, and APIs), **budget awareness** (cost is part of the loop, not an afterthought), **cross-vertical execution** (code, trading, research, marketing, ops), and **hard stopping conditions** (wallet balance is a real constraint, not a suggestion).

That is why Franklin is an economic agent, not just a task agent.

---

## What Franklin can execute

Franklin is **chat-first**. You do not wire a DAG, configure six API keys, or commit to one model vendor. You state an outcome. Franklin decides what to read, search, fetch, call, and pay for.

### 📈 Trading signals

```text
> what's BTC looking like today?

  ✓ TradingSignal  BTC

  ## BTC Signal Report

  Price: $71,056 USD (+2.3% 24h)
  Market Cap: $1.42T
  24h Volume: $29.6B

  ### Technical Indicators (30d)
  - RSI(14): 53.2 — neutral
  - MACD: 339.21 / Signal: 280.45 — bullish crossover
  - Bollinger: within band (upper $73,773 / lower $64,545)
  - Volatility: 35.3% annualized — medium

> if I enter at 65000 with $1000, where should my stop be?

  Based on ATR(14) and support at $63,500:
  Entry: $65,000 · Stop: $63,200 (−2.8%) · Risk: $27.69
  Risk/reward to $70K target: 1:2.8 ✓
```

Live data from CoinGecko. RSI, MACD, Bollinger, and volatility computed locally. No API key needed.

### 🛡️ Trades only move on YOUR approval

Real-money trades (Jupiter, 0x, Polymarket) are hard-gated behind a **trade plan**: the agent proposes a structured plan — venue, asset, size, slippage, stop condition, rationale, total spend — and nothing executes until you approve it. Approved budgets draw down per trade and expire in 15 minutes. This holds in every permission mode, `--trust` included. Add your own guardrails as [lifecycle hooks](docs/examples/hooks/) — daily spend caps, token blacklists, spend ledgers — that veto actions before money moves.

### 🎯 Autonomous goals with adversarial verification

```text
> /goal research the top 3 x402-compatible data APIs and produce a comparison
```

Franklin plans the objective, works it across turns on its own, and — when it claims completion — a panel of **adversarial reviewers audits the evidence and refutes anything unsupported**. Bounded by a turn cap, a verification-round cap, and your `--max-spend`. Esc pauses at any time. Pair with `/loop 1h check funding rates` (durable scheduler) and the `Monitor` tool (live feeds delivered at turn boundaries) for always-on market coverage.

### 🧠 A memory that follows your wallet

Every trade journals itself: thesis on open, P&L on close, written to a **wallet-keyed trading journal** (`~/.blockrun/memory/trading-*/`) that any session can recall — "what was my SOL thesis?" just works, from any directory. Session learnings capture with `/flush`, consolidate with `/dream`, and inject automatically at session start.

### 🕹️ Mission control for your fleet

`franklin serve` + `franklin panel` → the **Agents** tab: dispatch one agent per strategy or market, watch them stream live, reply to any of them, and approve their trade plans and permission requests — all from one browser page. Sessions started in a terminal show up too.

### 🎨 Image generation

```text
> generate a logo for my AI startup — minimalist, dark background

  ✓ ImageGen  "minimalist AI startup logo, dark background..."
  Saved: generated-logo-1713052800.png (1024x1024)
```

Generates images via DALL-E / GPT Image directly from the CLI. Paid from your selected BlockRun API account or wallet — no OpenAI API key needed.

### 📱 Remote control via Telegram

Run `franklin telegram` on an always-on machine (set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_OWNER_ID`) and drive Franklin from your phone. Owner-locked, session-resumable across restarts, slash commands (`/new`, `/balance`, `/status`). Trading, content, dev work — all reachable from a Telegram chat.

### 🔎 Research, code, anything with a budget

```text
> compare the top 5 AI agent pricing models, summarize the patterns, and save a note for me

  ✓ WebSearch  ai agent pricing models
  ✓ WebFetch   5 articles
  ✓ Write      notes/agent-pricing.md

  Summary:
  - Most agents hide pricing behind monthly seats
  - Usage-based products win with power users and teams
  - Wallet-based billing is still basically empty whitespace
```

```text
> refactor src/auth.ts to use the new jwt helper, then run the tests

  ✓ Read   src/auth.ts                    $0.002
  ✓ Read   src/lib/jwt.ts                 $0.001
  ✓ Edit   src/auth.ts (-24 +31 lines)    $0.008
  ✓ Bash   npm test                       $0.000
    › 142 passing · 0 failing · 2.4s

  Done in 18s · $0.011
```

Code is still first-class. It is just **one workload**, not the category.

Every tool call is itemized. Every token is priced. When the wallet hits zero, Franklin stops. No overdraft, no surprise bill, no rate-limit wall at 3 a.m. — this is YOPO in practice.

---

## Smart Router

**<!-- br:models.chatVisible -->76<!-- /br:models.chatVisible --> models. One decision. Zero guesswork.**

You don't pick models. Franklin picks for you.

The Smart Router classifies every request — coding, trading, reasoning, research — and selects the model with the best quality-to-cost ratio. Trained on **2M+ real requests** from the BlockRun gateway, continuously updated.

```text
> refactor this auth module to use JWT

  CODING kimi-k2.5  ·  12.4K in / 2.1K out  ·  $0.0023  saved 84%

> what's the BTC outlook for the week?

  TRADING grok-4-1-fast-reasoning  ·  8.2K in / 1.8K out  ·  $0.0008  saved 95%

> prove that this algorithm is O(n log n)

  REASONING claude-sonnet-4.6  ·  15.1K in / 3.4K out  ·  $0.0312
```

Every response shows which model was chosen, why, and how much you saved vs. always using the most expensive option.

**Four profiles:**

| Profile | Strategy | Use case |
|---------|----------|----------|
| `auto` | Best quality-to-cost ratio | Default — smart spend |
| `eco` | Cheapest model with decent quality | Budget-conscious |
| `premium` | Highest quality regardless of cost | Mission-critical |
| `free` | Free NVIDIA models only | Zero wallet balance |

**Per-session breakdown** — run `/cost` to see exactly where your USDC went:

```text
Session Cost: $0.0847 (23 requests)
  gemini-2.5-flash       $0.0012   14 req   CODING
  kimi-k2.5              $0.0423    6 req   CODING
  claude-sonnet-4.6      $0.0412    3 req   REASONING
```

The router also learns from **your** usage. If you keep retrying a model for coding tasks, Franklin adapts and picks a better one next time. Your router gets smarter the more you use it.

---

## Why Franklin

<table>
<tr>
<td width="33%" valign="top">

### 💳 &nbsp;AI is utility, not SaaS

You don't subscribe to electricity, you pay for what you use. Franklin brings the same model to AI. YOPO settlement means Franklin never bills you for access, only for outcomes. No monthly fees, no rate limits, no overdraft.

</td>
<td width="33%" valign="top">

### 🧠 &nbsp;Multi-model is the future

No single model is best at everything. Sonnet writes better code, Gemini handles longer context, DeepSeek costs 20x less for simple tasks. The Smart Router routes every request to the optimal model in <1ms — <!-- br:savings.autoVsBaselinePct -->84<!-- /br:savings.autoVsBaselinePct -->% cheaper than pinning Claude Opus 5 for every request.

</td>
<td width="33%" valign="top">

### 🔐 &nbsp;Wallet is identity

No email. No phone. No KYC. Your Solana or Base address is your account — portable, permissionless, global. A wallet requires only USDC. (Prefer an account and a card? [Two ways to pay](#two-ways-to-pay) — the key route exists, it just is not the one that makes the agent sovereign.)

</td>
</tr>
</table>

---

## The comparison

|                                        | Coding agents    | Editor IDEs      | Chatbots         | **Franklin**                    |
| -------------------------------------- | ---------------- | ---------------- | ---------------- | ------------------------------- |
| Writes code                            | ✅               | ✅               | ⚠️                | ✅                              |
| **Spends money for you**               | ❌               | ❌               | ❌               | ✅ **USDC wallet, x402**        |
| **Buys data + APIs + images + search** | ❌               | ❌               | ❌               | ✅ **55+ APIs, one wallet**     |
| Picks best model per task              | ❌ single-vendor | ❌ plan-tied    | ❌               | ✅ **Smart Router, <!-- br:models.chatVisible -->76<!-- /br:models.chatVisible --> models** |
| Pricing model                          | Subscription     | Subscription     | Subscription     | **YOPO** — per outcome, USDC    |
| Monthly fee                            | $20–$200         | $20–$40          | $20+             | **$0**                          |
| Rate-limited                           | Yes              | Yes              | Yes              | No — limited only by wallet     |
| Works when provider goes down          | ❌               | ❌               | ❌               | ✅ **routes to another**        |
| Identity                               | Vendor account   | Vendor account   | Account / email  | ✅ **wallet, no signup**        |
| Start free, no KYC                     | ❌               | ❌               | ❌               | ✅                              |
| Source                                 | Closed           | Closed           | Closed           | **Apache 2.0, local-first**     |

**Franklin is the economic agent category in one sentence:** software with a wallet that can spend toward a result.

---

## Features

<table>
<tr>
<td width="50%" valign="top">

**💼 Wallet-native economic execution**
Franklin can decide what is worth paying for, route the call, sign the micropayment, and keep going until the goal is done or the budget is exhausted.

**📈 Trading signals**
Ask "what's BTC looking like?" — Franklin fetches live price data, computes RSI/MACD/Bollinger/volatility, and synthesizes a signal.

**🎨 AI image generation**
Ask "generate a logo" — Franklin calls DALL-E / GPT Image, saves the result locally, paid from your wallet.

**🧠 <!-- br:models.chatVisible -->76<!-- /br:models.chatVisible --> models via one wallet**
Anthropic, OpenAI, Google, xAI, DeepSeek, GLM, Kimi, Minimax, NVIDIA free tier. One wallet, one interface, automatic fallback.

**💳 x402 micropayments (YOPO)**
HTTP 402 native. Every paid action is a signed USDC micropayment via EIP-712 — non-custodial, your keys never leave your machine. YOPO: you pay only for outcomes.

**🧠 Learned model router**
Trained on 2M+ real requests. Classifies your task and picks the best model from <!-- br:models.chatVisible -->76<!-- /br:models.chatVisible --> LLMs. Four profiles (auto/eco/premium/free). Adapts to your usage over time.

</td>
<td width="50%" valign="top">

**🛠 16 built-in tools**
Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, Task, ImageGen, VideoGen, MemoryRecall, AskUser, SubAgent, TradingSignal, TradingMarket, TradingPortfolio, TradingOpenPosition, TradingClosePosition, TradingHistory.

**💾 Persistent sessions**
Every turn is streamed to disk with metadata. Resume any session by ID. Survives crashes, reboots, and compaction.

**🔍 Full-text session search**
`franklin search "payment loop"` from the CLI, or `/session-search "payment loop"` in chat.

**📊 Cost insights**
`franklin insights` shows spend breakdowns, trends, and projections. Never wonder where the USDC went.

**⚡ Anthropic prompt caching**
Multi-turn Sonnet/Opus sessions use ephemeral cache breakpoints to reduce input spend on long conversations.

**🔌 Plugin SDK + MCP**
Core is workflow-agnostic. Add new verticals without touching the loop. Discover external tools automatically through MCP.

</td>
</tr>
</table>

---

## Slash commands

| Command                          | What it does                                         |
| -------------------------------- | ---------------------------------------------------- |
| `/model [name]`                  | Interactive model picker, or switch directly         |
| `/plan` / `/execute`             | Read-only planning mode / execution mode             |
| `/ultrathink <q>`                | Deep reasoning mode for hard problems                |
| `/compact`                       | Structured context compression                       |
| `/search <q>`                    | Search the codebase                                  |
| `/session-search <q>`            | Search past sessions                                 |
| `/history` / `/resume [id]`      | Inspect or restore conversation state                |
| `/commit` / `/push` / `/pr`      | Git workflow helpers                                 |
| `/review` / `/fix` / `/test`     | One-shot code review, bugfix, or test runs           |
| `/cost` / `/wallet`              | Session cost, wallet address, and balance            |
| `/insights [--days N]`           | Rich usage analytics                                 |
| `/help`                          | Full command list                                    |

---

## How it works

```text
┌──────────────────────────────────────────────────────────────┐
│  Franklin Runtime                                            │
│  Intent → Smart Router → Tool Use → Spend Control → Result   │
├──────────────────────────────────────────────────────────────┤
│  Learned Router                                              │
│  2M+ requests · <!-- br:models.chatVisible@live -->76<!-- /br:models.chatVisible@live --> models · category detection · Elo scores │
├──────────────────────────────────────────────────────────────┤
│  Agent Loop                                                  │
│  16 tools · Sessions · Compaction · Pricing · Plugin SDK     │
├──────────────────────────────────────────────────────────────┤
│  BlockRun Gateway                                            │
│  <!-- br:models.chatVisible@live -->76<!-- /br:models.chatVisible@live --> LLMs · CoinGecko · Search · Image APIs · paid services  │
├──────────────────────────────────────────────────────────────┤
│  x402 Micropayment Protocol                                  │
│  HTTP 402 · USDC on Solana & Base · signed payment payloads  │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
                     ┌─────────────┐
                     │ Your wallet │
                     │  (you own)  │
                     └─────────────┘
```

The loop is simple:
1. You state an outcome.
2. Franklin chooses what to read, call, and pay for.
3. The payment settles against your wallet.
4. Franklin reports the result and the spend.

That economic loop is the product.

---

## Project layout

```text
src/
├── index.ts           CLI entry (franklin)
├── banner.ts          Ben Franklin portrait + FRANKLIN gradient text
├── agent/             Agent loop, LLM client, compaction, commands
├── tools/             20+ built-in tools (Read/Write/Edit/Bash/Glob/Grep/
│                      WebFetch/WebSearch/Task/ImageGen/VideoGen/
│                      MemoryRecall/AskUser/SubAgent/Trading*/Content*)
├── trading/           Market data (CoinGecko) + technical indicators
├── content/           Content library with budget-bound media generation
├── brain/             Cross-session entity knowledge graph
├── channel/           Non-CLI ingress drivers (Telegram today)
├── events/            Internal event bus
├── plugin-sdk/        Public plugin contract (Workflow/Plugin/Channel)
├── plugins/           Plugin registry + runner (plugin-agnostic)
├── session/           Persistent sessions + search + channel tags
├── stats/             Usage tracking + insights engine
├── ui/                Ink-based terminal UI
├── proxy/             Payment proxy for external tools
├── router/            Learned model router (<!-- br:models.chatVisible@live -->76<!-- /br:models.chatVisible@live --> models, Elo scoring)
├── wallet/            Wallet management (Base + Solana)
├── mcp/               MCP server auto-discovery
└── commands/          CLI subcommands
```

---

## Free tier, for real

Start with **zero dollars**. Franklin defaults to free NVIDIA models that need **no wallet and no API key** — nothing to fund, nothing to sign up for.

```bash
franklin --model free
```

Once you fund it — [either way](#two-ways-to-pay) — Franklin gets more purchasing power: Sonnet, Opus, GPT, Gemini, Grok, and paid tools like Exa, image generation, and live market data.

---

## Remote control via Telegram

Drive Franklin from anywhere with a bot token:

```bash
export TELEGRAM_BOT_TOKEN=<from @BotFather>
export TELEGRAM_OWNER_ID=<your numeric Telegram user id>
franklin telegram                # start the bot (owner-locked)
```

Session state resumes across process restarts (tagged by owner id).
Slash commands `/new`, `/balance`, `/status`, `/help` handled locally
by the bot layer; everything else forwards to the agent. Progressive
streaming flushes partial answers at paragraph boundaries so long
replies don't wait for turn-end.

Same wallet. Same tools. From your phone.

---

## Documentation

Full BlockRun docs: **https://blockrun.ai/docs**

- [Agent developer guide](https://blockrun.ai/docs/getting-started/agent-developers) — building agents on BlockRun
- [Models, SDKs & APIs](https://blockrun.ai/docs) — the full gateway reference
- [Plugin SDK guide](docs/plugin-sdk.md) — build your own workflow vertical
- [Changelog](CHANGELOG.md) — every release explained
- [Roadmap](docs/ROADMAP.md) — what's coming next
- [Proxy mode](docs/) — use Franklin as a payment proxy for Anthropic-compatible CLI agents

---

## Community

- [Telegram](https://t.me/blockrunAI) — realtime help, bug reports, feature requests
- [@BlockRunAI](https://x.com/BlockRunAI) — release notes, demos
- [Issues](https://github.com/BlockRunAI/Franklin/issues) — bugs and feature requests

---

## Contributors

Franklin ships work from outside the core team on a regular basis: typed Phone & Voice tools, the `/market` command, the model picker catalog, Jupiter precision guards, and the bug reports behind the prompt-caching, stream-timeout, and wallet-reservation fixes.

The full list, with what each person shipped, lives in [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md). Thank you.

PRs welcome — see the Development section below for the local loop.

---

## Development

```bash
git clone https://github.com/BlockRunAI/Franklin.git
cd franklin
npm install
npm run build
npm test              # deterministic local tests — no API calls
npm run test:e2e      # live e2e tests — free smoke works unfunded; paid tools need network + funded wallet
npm run test:free-models # live matrix across current free NVIDIA models
node dist/index.js --help
```

### Desktop app

The stable Franklin Desktop shell lives in [`apps/desktop`](apps/desktop). It uses
the Franklin runtime built by this monorepo, so CLI and Desktop changes are
versioned and tested together. See the [Desktop guide](apps/desktop/README.md) for
the product status, security model, and complete development workflow.

```bash
npm run desktop:dev       # Desktop UI with the local mock agent
npm run desktop:real --workspace @blockrun/franklin-desktop # real Franklin agent
npm run desktop:build     # type-check and build the renderer
npm run desktop:package:mac
npm run desktop:package:win
```

Packaged builds create a private, per-launch credential for the local Franklin
service, keep cloud session sync off unless the user explicitly enables it, and
use `Documents/Franklin` as the default workspace. Files outside that workspace
remain available after an explicit approval, similar to other coding agents.
Team Mode is being developed separately and is not part of this stable integration.

For the recommended live validation order and failure triage, see [docs/live-e2e-checklist.md](docs/live-e2e-checklist.md).

**Contributing:** open an issue first to discuss meaningful changes. PRs welcome on bugs, docs, new models in pricing, and new tools.

---

## License

Apache-2.0. See [LICENSE](LICENSE).

---

<div align="center">

**The AI agent with a wallet.**<br>
<sub>YOPO — You Only Pay Outcome. Your wallet. Your budget. Your results.</sub>

<br>

<sub>From the team at <a href="https://blockrun.ai">BlockRun</a>.</sub>

</div>
