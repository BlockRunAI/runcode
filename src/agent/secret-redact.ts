/**
 * Secret detection + redaction for user-submitted text.
 *
 * Why this exists: a user pasted a GitHub PAT (`ghp_...`) directly into
 * chat as a way to give Franklin authenticated access to the GitHub API.
 * The model correctly refused to use the raw value and warned the user,
 * but by then the token had already entered:
 *   - the LLM API request body (sent to the gateway + upstream provider)
 *   - the persisted session file on disk
 *   - any later compaction summary (which would re-send it to the model)
 *
 * What the user actually wants is for Franklin to **remember the credential
 * and keep using it**, not refuse it. So this module's job is two-fold:
 *
 *   1. Strip the raw value out of the conversation so it never reaches
 *      the model, history, or disk.
 *   2. Stash it on `process.env` under a predictable name so subsequent
 *      Bash / WebFetch tool calls can reference it via `$GITHUB_TOKEN`,
 *      `$ANTHROPIC_API_KEY`, etc. — no chat round-trip needed.
 *
 * Conservative pattern set: each entry matches a token format with an
 * unambiguous prefix + length, so false positives are rare. Anything that
 * could plausibly be a normal long string (random hex, base64 blobs) is
 * deliberately not in here. False positives are worse than missed
 * detections — silently mangling a hex hash a user pasted would be
 * confusing and there's no recovery path.
 */

interface SecretPattern {
  /** Human-readable label used in [REDACTED:label] and the warning. */
  label: string;
  /** Regex with /g flag — match[0] must capture the entire secret. */
  pattern: RegExp;
  /** One-line description shown in the warning. */
  description: string;
  /** Env var name we stash the value under (caller's choice to actually set). */
  envVar: string;
}

const SECRET_PATTERNS: SecretPattern[] = [
  // ── GitHub ──
  // Personal access tokens, OAuth tokens, app installation/user-to-server
  // tokens, fine-grained PATs. All have unique prefixes the user can verify.
  {
    label: 'github_pat',
    pattern: /\bghp_[A-Za-z0-9]{36,}\b/g,
    description: 'GitHub personal access token',
    envVar: 'GITHUB_TOKEN',
  },
  {
    label: 'github_oauth',
    pattern: /\bgho_[A-Za-z0-9]{36,}\b/g,
    description: 'GitHub OAuth token',
    envVar: 'GITHUB_TOKEN',
  },
  {
    label: 'github_app',
    pattern: /\bghs_[A-Za-z0-9]{36,}\b/g,
    description: 'GitHub App installation token',
    envVar: 'GITHUB_TOKEN',
  },
  {
    label: 'github_user',
    pattern: /\bghu_[A-Za-z0-9]{36,}\b/g,
    description: 'GitHub user-to-server token',
    envVar: 'GITHUB_TOKEN',
  },
  {
    label: 'github_pat_fine',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
    description: 'GitHub fine-grained PAT',
    envVar: 'GITHUB_TOKEN',
  },

  // ── Anthropic ──
  {
    label: 'anthropic_api',
    pattern: /\bsk-ant-(?:api|admin)\d+-[A-Za-z0-9_-]{20,}\b/g,
    description: 'Anthropic API key',
    envVar: 'ANTHROPIC_API_KEY',
  },

  // ── OpenAI ──
  // sk-proj- (project keys, current format) is unambiguous. The legacy
  // `sk-` + 48 chars format is more ambiguous so we require ≥48 chars to
  // avoid clashing with normal short hex strings.
  {
    label: 'openai_project',
    pattern: /\bsk-proj-[A-Za-z0-9_-]{40,}\b/g,
    description: 'OpenAI project API key',
    envVar: 'OPENAI_API_KEY',
  },
  {
    label: 'openai_api',
    pattern: /\bsk-[A-Za-z0-9]{48,}\b/g,
    description: 'OpenAI API key',
    envVar: 'OPENAI_API_KEY',
  },

  // ── AWS ──
  {
    label: 'aws_access_key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    description: 'AWS access key ID',
    envVar: 'AWS_ACCESS_KEY_ID',
  },
  // AWS secret keys are 40 base64 chars but have no prefix — too ambiguous
  // to match safely. Skipped on purpose.

  // ── Google ──
  {
    label: 'google_api',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    description: 'Google Cloud / Firebase API key',
    envVar: 'GOOGLE_API_KEY',
  },

  // ── Slack ──
  {
    label: 'slack_token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    description: 'Slack token',
    envVar: 'SLACK_TOKEN',
  },

  // ── Stripe ──
  // ── BlockRun ──
  // Prepaid API keys for the api.blockrun.ai gateway. Franklin reads these
  // from BLOCKRUN_API_KEY / ~/.blockrun/api-key, so without this pattern a
  // key can reach transcripts, `franklin logs`, and any model prompt that
  // echoes the environment.
  {
    label: 'blockrun_api_key',
    pattern: /\bbrk_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
    description: 'BlockRun gateway API key',
    envVar: 'BLOCKRUN_API_KEY',
  },

  {
    label: 'stripe_live',
    pattern: /\bsk_live_[A-Za-z0-9]{20,}\b/g,
    description: 'Stripe live secret key',
    envVar: 'STRIPE_SECRET_KEY',
  },
  {
    label: 'stripe_test',
    pattern: /\bsk_test_[A-Za-z0-9]{20,}\b/g,
    description: 'Stripe test secret key',
    envVar: 'STRIPE_SECRET_KEY',
  },

  // ── Twilio ──
  {
    label: 'twilio_account',
    pattern: /\bAC[a-f0-9]{32}\b/g,
    description: 'Twilio account SID',
    envVar: 'TWILIO_ACCOUNT_SID',
  },

  // ── Private keys ──
  // Multi-line PEM blocks. Match begin/end markers + content. envVar:
  // PRIVATE_KEY is generic — if a user has multiple they'll need to rename.
  {
    label: 'private_key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY-----/g,
    description: 'PEM private key',
    envVar: 'PRIVATE_KEY',
  },

  // ── Cryptocurrency private keys ──
  // 64-char hex strings preceded by an obvious key context. Standalone hex
  // strings are too ambiguous (could be hashes) to redact silently.
  {
    label: 'eth_private_key',
    pattern: /\b(?:private[_\s-]?key|priv[_\s-]?key|secret[_\s-]?key)\s*[:=]\s*0x[a-fA-F0-9]{64}\b/gi,
    description: 'Ethereum-style private key',
    envVar: 'WALLET_PRIVATE_KEY',
  },
  {
    // Solana secret keys are base58 (~88 chars). Label-gated + length-gated
    // (>=64 excludes 32-44 char PUBLIC addresses) so we never mask a bare hash
    // or signature — e.g. solana-wallet.json's `"private_key": "<base58>"`.
    label: 'solana_private_key',
    pattern: /(?:private[_\s-]?key|priv[_\s-]?key|secret[_\s-]?key)"?\s*[:=]\s*"?[1-9A-HJ-NP-Za-km-z]{64,128}/gi,
    description: 'Solana-style base58 private key',
    envVar: 'WALLET_PRIVATE_KEY',
  },
];

export interface RedactionMatch {
  label: string;
  description: string;
  /** First 4 chars of the secret + ellipsis — for user-facing display. */
  preview: string;
  /** Suggested env var name (e.g. GITHUB_TOKEN). */
  envVar: string;
  /** The actual secret value. INTERNAL USE ONLY — never log this. */
  value: string;
}

export interface RedactionResult {
  /** Input with each secret replaced by [REDACTED:label]. */
  redactedText: string;
  /** What got redacted. Includes raw `value` for the caller to stash. */
  matches: RedactionMatch[];
}

/**
 * Scan `input` for secret patterns and return a redacted copy plus a
 * description of what was caught. Secrets are replaced with the literal
 * string `[REDACTED:<label>]` so the model can still see *something* was
 * there (helpful when the user's message refers to the token in context),
 * just not the value.
 *
 * No I/O, no logging — pure transformation. The caller decides how to
 * surface the warning to the user and whether to stash values on
 * process.env (recommended for CLI usage so Bash tool calls can reference
 * $GITHUB_TOKEN etc).
 */
export function redactSecrets(input: string): RedactionResult {
  let redactedText = input;
  const matches: RedactionMatch[] = [];
  // Dedupe by exact value, not by label — a user might paste two distinct
  // GitHub tokens and we should preserve both for the env-var stash even
  // though the description would read identically.
  const seenValues = new Set<string>();

  for (const { label, pattern, description, envVar } of SECRET_PATTERNS) {
    // Reset lastIndex on each pattern — RegExp objects with /g preserve it
    // across calls, which would skip matches if the same regex were reused.
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(input)) !== null) {
      const secret = match[0];
      if (seenValues.has(secret)) continue;
      seenValues.add(secret);
      matches.push({
        label,
        description,
        preview: secret.slice(0, 4) + '…',
        envVar,
        value: secret,
      });
      // Replace every occurrence of this exact secret in redactedText.
      // Using the literal secret as a search string handles the common
      // case where the same token appears multiple times in one message.
      redactedText = redactedText.split(secret).join(`[REDACTED:${label}]`);
    }
  }

  return { redactedText, matches };
}

/**
 * Stash matched secrets onto `process.env` so subsequent tool calls
 * (Bash, WebFetch with `$GITHUB_TOKEN`-style references) can use them
 * without the value ever round-tripping through chat history.
 *
 * Returns the names of env vars that were set, deduped, in stash order.
 * Safe to call on an empty match list (no-op).
 */
/**
 * Redact secrets from text Franklin did not author — tool output, not user
 * input.
 *
 * `redactSecrets` above is the INPUT path: it scrubs what a user pastes into
 * chat and hands the caller the raw values to stash on process.env. That is
 * the wrong contract here. Tool output flows straight into the model prompt
 * (over the network, to whichever gateway model serves the turn) and into the
 * persisted session transcript on disk, so the value must not survive at all
 * and there is nothing to stash.
 *
 * The case that forced this: `printenv` and `echo` are auto-approved by
 * bash-guard as safe commands, so `printenv BLOCKRUN_API_KEY` needed no
 * confirmation and returned the account bearer key as tool output. Stripping
 * the variable from the Bash subprocess env (tools/bash.ts) closes that exact
 * command; this closes the class — a key can still reach output via a config
 * file, a `curl -v` trace, an MCP result, or a shell history dump.
 *
 * `extraLiterals` carries values known only at runtime, e.g. the configured
 * API key when it does not match a published prefix shape. Empty and very
 * short entries are ignored so a blank env var cannot blank out the text.
 */
export function redactSecretsInOutput(
  input: string,
  extraLiterals: readonly string[] = [],
): { text: string; labels: string[] } {
  if (!input) return { text: input, labels: [] };
  let text = input;
  const labels: string[] = [];

  for (const literal of extraLiterals) {
    const value = literal?.trim();
    // 8 is below any credential this guards and above the length at which a
    // stray value would collide with ordinary output.
    if (!value || value.length < 8) continue;
    if (!text.includes(value)) continue;
    text = text.split(value).join('[REDACTED:configured_credential]');
    labels.push('configured_credential');
  }

  for (const { label, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (!pattern.test(text)) continue;
    pattern.lastIndex = 0;
    text = text.replace(pattern, `[REDACTED:${label}]`);
    labels.push(label);
  }

  return { text, labels: [...new Set(labels)] };
}

export function stashSecretsToEnv(matches: RedactionMatch[]): string[] {
  const set: string[] = [];
  for (const m of matches) {
    // Don't clobber an env var the user has already exported in their
    // shell — their existing value is presumably the right one and
    // accidentally overwriting it could cause silent breakage.
    if (process.env[m.envVar] && process.env[m.envVar] !== m.value) {
      continue;
    }
    process.env[m.envVar] = m.value;
    if (!set.includes(m.envVar)) set.push(m.envVar);
  }
  return set;
}

/**
 * Build a one-paragraph warning + usage hint to surface to the user when
 * their input had secrets redacted and stashed. Names what was caught
 * (with previews, never values) and tells them how to actually use the
 * stashed credential going forward.
 */
export function formatRedactionWarning(
  matches: RedactionMatch[],
  envVarsSet: string[],
): string {
  if (matches.length === 0) return '';
  const list = matches
    .map((m) => `• ${m.description} (${m.preview}) → \`$${m.envVar}\``)
    .join('\n');
  const skipped = matches.length - envVarsSet.length;
  const skippedNote = skipped > 0
    ? `\n_(${skipped} value${skipped === 1 ? '' : 's'} not stashed because the env var was already set in your shell — your existing export is preserved.)_`
    : '';
  return (
    `\n⚠️ **Secret detected, redacted from chat, and stashed for this session.**\n` +
    `${list}${skippedNote}\n\n` +
    `The raw value never reached the model, the conversation history, or the session file. ` +
    `Tool calls (Bash / WebFetch) can use the env var name — for example: ` +
    `\`gh api user --header "Authorization: Bearer $GITHUB_TOKEN"\`.\n\n` +
    `**This still counts as exposed.** Anything you typed is in your terminal scrollback, ` +
    `and any prior session file may have captured it before this redaction was added. ` +
    `Treat the secret as compromised and rotate it now.\n\n` +
    `Next time, set the credential via shell export before launching Franklin ` +
    `(\`export GITHUB_TOKEN=...\`) instead of pasting it into chat.\n`
  );
}
