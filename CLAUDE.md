# Franklin

**The AI agent with a wallet.**

_Billing has two rails as of 3.44.0: a USDC wallet (x402) or a prepaid BlockRun account key. Wallet is the identity and the story; the key is the on-ramp for people who would rather top up a balance. On-chain actions always need the wallet._

Franklin is a **general autonomous economic agent** — it doesn't just write text, it autonomously spends real money (USDC from a user-funded wallet, or prepaid account credits) to execute real work — with **trading as the flagship vertical**. It is explicitly NOT positioned as a coding agent (decided 2026-07-17): file/shell tools are kept as general infrastructure (strategy scripts, data analysis) but faded from positioning, docs, and the default experience.

Capability pillars:
- **Trading agent (flagship)** — signals, portfolio, risk, trade-plan approvals, wallet-keyed journal, persistent P&L
- **Autonomy** — /goal (adversarially verified objectives), /loop scheduler, Monitor, lifecycle hooks, multi-agent mission control (panel Agents tab)
- **Content & research** — ImageGen, VideoGen, Exa research, budget-tracked production
- **General tools** — files/shell/search kept but not marketed

Built on three layers:
1. **x402 micropayment protocol** — HTTP 402 native payments
2. **BlockRun Gateway** — aggregates <!-- br:models.chatVisible -->76<!-- /br:models.chatVisible --> LLMs + paid APIs (Exa, DALL-E, future Runway/Suno/CoinGecko)
3. **Franklin Agent** — this repo, the reference client

## Commands

```bash
npm install              # install dependencies
npm run build            # compile TypeScript + copy plugin assets
npm run dev              # watch mode
npm start                # launch agent
npm test                 # local test suite (no API calls)
npm run test:e2e         # end-to-end tests (hits real models, needs wallet funding)
```

## Project structure

```
src/
├── index.ts                # CLI entry point (franklin)
├── banner.ts               # FRANKLIN ASCII banner
├── agent/                  # Agent loop, LLM client, compaction, commands
├── tools/                  # 12 built-in tools (Read/Write/Edit/Bash/Grep/...)
├── plugin-sdk/             # Public plugin contract (Workflow / Channel / Plugin)
├── plugins/                # Plugin registry + runner (plugin-agnostic core)
├── trading/                # Market data + indicators (exposed via tools/)
├── content/                # Content library (budget-bound media gen)
├── session/                # Persistent sessions + full-text search
├── stats/                  # Usage tracking + insights engine
├── ui/                     # Ink-based terminal UI
├── proxy/                  # Payment proxy for Anthropic-compatible CLI agents
├── router/                 # Smart model tier routing (free/cheap/premium)
├── wallet/                 # Base + Solana wallet management
├── commands/               # CLI subcommands
└── mcp/                    # MCP server integration (auto-discovery)
```

## Key dependencies

- `@blockrun/llm` — LLM gateway SDK with x402 payment handling
- `@modelcontextprotocol/sdk` — MCP protocol for extensible tools
- `@colbymchenry/codegraph` — built-in MCP server: local tree-sitter symbol/call graph (see `src/mcp/codegraph.ts`)
- `ink` / `react` — Terminal UI framework
- `commander` — CLI argument parsing

## Conventions

- TypeScript strict mode
- ESM (`"type": "module"`)
- Node >= 20
- Apache-2.0 license
- npm registry: `@blockrun/franklin`
- Binary command: `franklin`

## Positioning

**Franklin runs your money.** (Updated 2026-07-17 — NOT a coding agent.)

| Layer | Message | Audience |
|-------|---------|----------|
| External (X, YouTube, KOL) | **The AI Agent with a Wallet** — it holds your USDC and actually spends it for you | Everyone |
| Onboarding | **Or just top up an account** — `franklin login brk_...` for people not ready to fund a wallet | Newcomers |
| Core users / docs | **Autonomous Economic Agent** powered by x402 payment layer | Crypto AI community, power users |
| Product direction | **Trading flagship + general autonomy** — mission-control fleet, one agent per strategy/market | Power users |

Every feature decision should be tested against this positioning:

- Does it make Franklin more of "the agent with a wallet"? → yes
- Does it pull us into the coding-agent feature race? → no (explicitly out: worktrees, editor protocols, code plan mode, LSP, codebase indexing)

The moat is the payment layer plus the safety architecture around autonomous spending: trade-plan approvals (money never moves without one, trust mode included), lifecycle hooks as user guardrails, adversarially verified goals, and a wallet-keyed memory. Coding tools are general infrastructure — keep them working, don't market them. New prompts/templates/docs use task/trade/research framing, never coding framing.

**What sets Franklin apart:**
- Most agents can think but can't spend; the ones that spend have no guardrails
- Franklin: you fund it (wallet or account credits) and set the budget; it proposes, you approve, it executes and journals every trade
- Memory follows the wallet, goals survive sessions, and the whole fleet is visible in one panel
