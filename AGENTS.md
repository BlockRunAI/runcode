# Franklin Agent

Open-source AI agent with a wallet. <!-- br:models.chatVisible -->76<!-- /br:models.chatVisible --> models. Pay per use with BlockRun API account credit or USDC wallets via x402.

## Commands

```bash
npm install              # install dependencies
npm run build            # compile TypeScript
npm run dev              # watch mode
npm start                # launch agent
```

## Project structure

```
src/
├── index.ts             # CLI entry point
├── agent/               # Agent loop and orchestration
├── commands/            # Built-in agent commands
├── tools/               # Agent tools (file edit, shell, search, etc.)
├── router/              # Model routing logic
├── session/             # Session management
├── wallet/              # USDC wallet (Base/Solana)
├── mcp/                 # MCP server integration
├── ui/                  # Ink-based terminal UI
├── config.ts            # Configuration
├── pricing.ts           # Per-model pricing
├── stats/               # Usage statistics
├── proxy/               # Request proxying
└── banner.ts            # Startup banner
```

## Key dependencies

- `@blockrun/llm` — LLM gateway SDK (x402 payments)
- `@modelcontextprotocol/sdk` — MCP protocol
- `ink` / `react` — Terminal UI
- `commander` — CLI framework

## Conventions

- TypeScript strict mode
- ESM (`"type": "module"`)
- Node >= 20
- Apache-2.0 license
- npm registry: `@blockrun/franklin`
