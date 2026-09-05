# Franklin Desktop

Franklin Desktop is the native Electron interface for the Franklin agent. It
lives in the main Franklin repository so every Desktop release is built from a
reviewed Franklin runtime and the matching UI.

## Current beta

- Franklin chat with streaming tool activity and inline permission requests
- local Base and Solana wallets with in-app network switching, or prepaid account billing via a BlockRun API key
- model catalog, skills, MCP, media generation, wallet activity, and market tools
- Agent Studio for discovering and importing supported local agent runtimes
- personal and Team conversation spaces
- Team projects with members, shared conversations, and versioned files
- local Team sidecar protected by per-launch tokens and strict loopback access

Private keys remain in the local Franklin process. The renderer receives only
the wallet address, balance, network, and the narrow operations exposed by the
Electron preload bridge.

## Development

Run commands from the Franklin repository root:

```bash
npm ci
npm run build
npm run desktop:real
```

For UI development with the mock agent backend:

```bash
npm run desktop:dev
```

The Vite renderer, Franklin agent, and Team sidecar use loopback-only services.
Packaged builds select ephemeral ports and pass unguessable credentials through
the isolated preload bridge.

## Validation

```bash
npm run typecheck --workspace @blockrun/franklin-desktop
npm run lint --workspace @blockrun/franklin-desktop
npm test --workspace @blockrun/franklin-desktop
npm run build --workspace @blockrun/franklin-desktop
```

The test suite covers Electron URL and IPC boundaries, hostile WebSocket
origins, the Team control plane, sandbox staging, SIWE authentication, and the
Team-to-Franklin agent proxy.

## Packaging

```bash
npm run desktop:package:mac
npm run desktop:package:win
```

`scripts/prepare-runtime.mjs` copies the main repository's built Franklin
runtime into the application before `electron-builder` creates the installer.
The release workflow builds macOS Apple Silicon and Windows x64 installers from
tags matching `desktop-v*`, then publishes them as a GitHub prerelease with
SHA-256 checksums.

Beta installers are currently unsigned. Users may need to confirm the first
launch through their operating system's security prompt.

## Team service

Electron starts `cloud-server/server.mjs` as a local sidecar. It accepts only an
explicit action allowlist and requires the per-process Desktop token. A private
remote Team endpoint can be configured with `FRANKLIN_TEAM_CLOUD_URL` or
`~/.blockrun/franklin-team-cloud-url`.

The included standalone control-plane and sandbox provider are development
testbeds. Production Team execution must use an isolated remote worker and
wallet broker rather than exposing a local runtime or Docker socket.

## License

Apache-2.0
