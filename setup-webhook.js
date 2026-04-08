#!/usr/bin/env node
/**
 * setup-webhook.js — Register a Jira webhook for OCR-EXTRACTION events
 *
 * Usage:
 *   node setup-webhook.js <WEBHOOK_URL>
 *
 * Example:
 *   node setup-webhook.js https://abc123.ngrok.io/webhook/jira
 *   node setup-webhook.js https://your-server.com/webhook/jira
 *
 * This script:
 *   1. Lists existing webhooks (checks for duplicates)
 *   2. Registers a new Jira webhook targeting the provided URL
 *   3. Filters for issue_updated events in the OCR project
 */

import 'dotenv/config';
import axios from 'axios';

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', grey: '\x1b[90m'
};

const HOST  = process.env.ATLASSIAN_HOST;
const EMAIL = process.env.ATLASSIAN_EMAIL;
const TOKEN = process.env.ATLASSIAN_TOKEN;
const PROJECT = process.env.JIRA_PROJECT_KEY || 'OCR';

function authHeaders() {
  const b64 = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');
  return {
    Authorization: `Basic ${b64}`,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
}

async function listWebhooks() {
  try {
    const url = `${HOST}/rest/webhooks/1.0/webhook`;
    const res = await axios.get(url, { headers: authHeaders() });
    return res.data || [];
  } catch (e) {
    // Jira Cloud may not support listing webhooks via REST — use admin UI
    if (e.response?.status === 403 || e.response?.status === 404) {
      console.log(`${c.yellow}⚠${c.reset}  Cannot list webhooks via API (requires admin). Using Jira admin UI instead.`);
      return null;
    }
    throw e;
  }
}

async function registerWebhook(webhookUrl) {
  console.log(`\n${c.bold}${c.cyan}╔════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}${c.cyan}║   Jira Webhook Registration                ║${c.reset}`);
  console.log(`${c.bold}${c.cyan}╚════════════════════════════════════════════╝${c.reset}\n`);

  if (!HOST || !EMAIL || !TOKEN) {
    console.error(`${c.red}✘${c.reset}  Missing ATLASSIAN_HOST / ATLASSIAN_EMAIL / ATLASSIAN_TOKEN in .env`);
    process.exit(1);
  }

  console.log(`${c.cyan}ℹ${c.reset}  Host:    ${HOST}`);
  console.log(`${c.cyan}ℹ${c.reset}  Project: ${PROJECT}`);
  console.log(`${c.cyan}ℹ${c.reset}  Target:  ${webhookUrl}`);

  // Check existing webhooks
  console.log(`\n${c.cyan}ℹ${c.reset}  Checking for existing webhooks...`);
  const existing = await listWebhooks();

  if (existing !== null) {
    const dup = existing.find(w => w.url === webhookUrl);
    if (dup) {
      console.log(`${c.yellow}⚠${c.reset}  Webhook already registered with this URL (ID: ${dup.self || dup.id})`);
      console.log(`${c.green}✔${c.reset}  No action needed.\n`);
      return;
    }
    console.log(`${c.grey}   Found ${existing.length} existing webhook(s)${c.reset}`);
  }

  // Register new webhook
  console.log(`\n${c.cyan}ℹ${c.reset}  Registering webhook...`);

  const payload = {
    name: `Flowise OCR Automation — ${PROJECT}`,
    url: webhookUrl,
    events: [
      'jira:issue_updated'
    ],
    filters: {
      'issue-related-events-section': `project = ${PROJECT}`
    },
    excludeBody: false
  };

  try {
    const url = `${HOST}/rest/webhooks/1.0/webhook`;
    const res = await axios.post(url, payload, { headers: authHeaders() });

    console.log(`${c.green}✔${c.reset}  ${c.bold}Webhook registered successfully!${c.reset}`);
    console.log(`${c.grey}   ID: ${res.data?.self || res.data?.id || 'unknown'}${c.reset}`);
    console.log(`${c.grey}   URL: ${webhookUrl}${c.reset}`);
    console.log(`${c.grey}   Events: jira:issue_updated${c.reset}`);
    console.log(`${c.grey}   Filter: project = ${PROJECT}${c.reset}\n`);
  } catch (e) {
    if (e.response?.status === 403) {
      console.log(`\n${c.yellow}⚠${c.reset}  API webhook registration requires Jira Admin access.`);
      console.log(`${c.yellow}⚠${c.reset}  Register manually via the Jira admin UI instead:\n`);
      printManualInstructions(webhookUrl);
    } else {
      console.error(`${c.red}✘${c.reset}  Registration failed: ${e.response?.data?.errorMessages?.join(', ') || e.message}`);
    }
  }
}

function printManualInstructions(webhookUrl) {
  console.log(`${c.bold}Manual Webhook Setup:${c.reset}`);
  console.log(`${'─'.repeat(50)}`);
  console.log(`1. Go to: ${c.cyan}${HOST}/plugins/servlet/webhooks${c.reset}`);
  console.log(`   (Or: Settings → System → WebHooks)`);
  console.log(`2. Click ${c.bold}"Create a WebHook"${c.reset}`);
  console.log(`3. Fill in:`);
  console.log(`   • Name:   ${c.cyan}Flowise OCR Automation${c.reset}`);
  console.log(`   • URL:    ${c.cyan}${webhookUrl}${c.reset}`);
  console.log(`   • Events: ☑ Issue → ${c.bold}updated${c.reset}`);
  console.log(`   • JQL:    ${c.cyan}project = ${PROJECT}${c.reset}`);
  console.log(`4. Click ${c.bold}"Create"${c.reset}`);
  console.log(`${'─'.repeat(50)}\n`);

  console.log(`${c.bold}For local development with ngrok:${c.reset}`);
  console.log(`${'─'.repeat(50)}`);
  console.log(`1. Install: ${c.cyan}npm install -g ngrok${c.reset}`);
  console.log(`2. Run:     ${c.cyan}ngrok http 3001${c.reset}`);
  console.log(`3. Copy the ${c.bold}https://*.ngrok.io${c.reset} URL`);
  console.log(`4. Use:     ${c.cyan}node setup-webhook.js https://<ngrok-id>.ngrok.io/webhook/jira${c.reset}`);
  console.log(`${'─'.repeat(50)}\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help')) {
  console.log(`\nUsage: node setup-webhook.js <WEBHOOK_URL>\n`);
  console.log(`Example:`);
  console.log(`  node setup-webhook.js https://abc123.ngrok.io/webhook/jira`);
  console.log(`  node setup-webhook.js https://your-server.com/webhook/jira\n`);

  if (HOST) {
    printManualInstructions('https://<your-server>/webhook/jira');
  }
  process.exit(0);
}

registerWebhook(args[0]).catch(err => {
  console.error(`${c.red}✘${c.reset}  ${err.message}`);
  process.exit(1);
});
