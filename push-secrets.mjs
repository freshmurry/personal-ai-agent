#!/usr/bin/env node
/**
 * scripts/push-secrets.mjs
 *
 * Reads your .env file and pushes every non-empty value to Cloudflare
 * Workers as a secret using `wrangler secret put`.
 *
 * Usage:
 *   npm run secrets:push
 *
 * NEVER commit .env — this script is safe to commit because it
 * only reads from .env at runtime and never embeds values.
 */

import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { resolve } from 'path';

const ENV_FILE = resolve(process.cwd(), '.env');

if (!existsSync(ENV_FILE)) {
  console.error('❌  .env file not found. Copy .env.example → .env and fill in values.');
  process.exit(1);
}

const lines = readFileSync(ENV_FILE, 'utf8').split('\n');
let pushed = 0, skipped = 0;

// Keys that are Worker vars (non-secret) — skip these, they live in wrangler.toml [vars]
const VAR_KEYS = new Set(['ENVIRONMENT', 'WORKER_URL']);

for (const line of lines) {
  const trimmed = line.trim();
  // Skip comments and blank lines
  if (!trimmed || trimmed.startsWith('#')) continue;

  const eqIdx = trimmed.indexOf('=');
  if (eqIdx === -1) continue;

  const key   = trimmed.slice(0, eqIdx).trim();
  const value = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');

  if (!value || VAR_KEYS.has(key)) {
    console.log(`⏭  Skipping ${key} (empty or var)`);
    skipped++;
    continue;
  }

  try {
    // Pipe value via stdin so it never appears in shell history
    execSync(`echo "${value}" | wrangler secret put ${key}`, {
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: true,
    });
    console.log(`✅  ${key}`);
    pushed++;
  } catch (err) {
    console.error(`❌  Failed to push ${key}:`, err.message);
  }
}

console.log(`\nDone: ${pushed} pushed, ${skipped} skipped.`);
