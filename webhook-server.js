#!/usr/bin/env node
/**
 * webhook-server.js — Express webhook listener for Jira events
 *
 * Listens for Jira webhook POST events when tickets are labeled "OCR-EXTRACTION".
 * Triggers the Flowise agentic flow to process the ticket autonomously.
 *
 * Usage:
 *   node webhook-server.js
 *   npm run webhook
 *
 * For local development:
 *   ngrok http 3001   (in a separate terminal)
 *   Then register the ngrok URL as the Jira webhook target
 */

import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import crypto from 'crypto';

const app = express();
app.use(express.json({ limit: '10mb' }));

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT           = process.env.WEBHOOK_PORT || 3001;
const FLOWISE_HOST   = process.env.FLOWISE_HOST || 'http://localhost:3000';
const CHATFLOW_ID    = process.env.FLOWISE_CHATFLOW_ID || '';
const FLOWISE_USER   = process.env.FLOWISE_USERNAME || '';
const FLOWISE_PASS   = process.env.FLOWISE_PASSWORD || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const TRIGGER_LABEL  = process.env.JIRA_TRIGGER_LABEL || 'OCR-EXTRACTION';
const TRANSITION_ID  = process.env.JIRA_DONE_TRANSITION_ID || '31';

// ─── Colours ─────────────────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', magenta: '\x1b[35m', grey: '\x1b[90m'
};

// ─── Deduplication ───────────────────────────────────────────────────────────
const processedEvents = new Map();
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes

function isDuplicate(eventId) {
  if (!eventId) return false;
  if (processedEvents.has(eventId)) return true;
  processedEvents.set(eventId, Date.now());
  // Clean old entries
  for (const [key, ts] of processedEvents) {
    if (Date.now() - ts > DEDUP_TTL_MS) processedEvents.delete(key);
  }
  return false;
}

// ─── Webhook signature validation ────────────────────────────────────────────
function validateSignature(req) {
  if (!WEBHOOK_SECRET) return true; // Skip if no secret configured
  const signature = req.headers['x-hub-signature'] || req.headers['x-atlassian-webhook-signature'];
  if (!signature) return false;
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
  hmac.update(JSON.stringify(req.body));
  const expected = `sha256=${hmac.digest('hex')}`;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ─── Flowise API call ────────────────────────────────────────────────────────
async function triggerFlowise(ticketId) {
  if (!CHATFLOW_ID) {
    console.error(`${c.red}✘${c.reset}  FLOWISE_CHATFLOW_ID not set. Cannot trigger flow.`);
    return null;
  }

  const url = `${FLOWISE_HOST}/api/v1/prediction/${CHATFLOW_ID}`;
  const headers = { 'Content-Type': 'application/json' };

  if (FLOWISE_USER && FLOWISE_PASS) {
    const b64 = Buffer.from(`${FLOWISE_USER}:${FLOWISE_PASS}`).toString('base64');
    headers['Authorization'] = `Basic ${b64}`;
  }

  const question = [
    `Process Jira ticket ${ticketId} for OCR extraction.`,
    `The ticket has been labeled "${TRIGGER_LABEL}" and needs OCR processing.`,
    `After processing, transition the ticket to Done using transition ID ${TRANSITION_ID}.`,
    `Context: JIRA_DONE_TRANSITION_ID=${TRANSITION_ID}`
  ].join('\n');

  console.log(`${c.cyan}ℹ${c.reset}  Calling Flowise: POST ${url}`);

  const res = await axios.post(url, {
    question,
    overrideConfig: {
      sessionId: `webhook-${ticketId}-${Date.now()}`
    }
  }, { headers, timeout: 120_000 });

  return res.data;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'flowise-ocr-webhook',
    timestamp: new Date().toISOString(),
    config: {
      flowiseHost: FLOWISE_HOST,
      chatflowId: CHATFLOW_ID ? '✓ set' : '✗ missing',
      triggerLabel: TRIGGER_LABEL,
      transitionId: TRANSITION_ID,
      webhookSecret: WEBHOOK_SECRET ? '✓ set' : '✗ not set'
    }
  });
});

// Main Jira webhook endpoint
app.post('/webhook/jira', async (req, res) => {
  const startTime = Date.now();
  const body = req.body;

  console.log(`\n${c.bold}${c.magenta}═══ Webhook Received ═══${c.reset} ${c.grey}${new Date().toISOString()}${c.reset}`);

  // Validate signature
  if (WEBHOOK_SECRET && !validateSignature(req)) {
    console.log(`${c.red}✘${c.reset}  Invalid webhook signature — rejecting`);
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Parse event
  const webhookEvent = body.webhookEvent || body.event || '';
  const issueKey = body.issue?.key || '';
  const issueId = body.issue?.id || '';
  const labels = body.issue?.fields?.labels || [];
  const changelog = body.changelog?.items || [];

  console.log(`${c.cyan}ℹ${c.reset}  Event: ${webhookEvent}`);
  console.log(`${c.cyan}ℹ${c.reset}  Issue: ${issueKey} (id: ${issueId})`);
  console.log(`${c.cyan}ℹ${c.reset}  Labels: ${labels.join(', ') || '(none)'}`);

  // Filter: only process issue_updated events
  if (!webhookEvent.includes('issue_updated') && !webhookEvent.includes('jira:issue_updated')) {
    console.log(`${c.grey}⊘${c.reset}  Ignoring event type: ${webhookEvent}`);
    return res.status(200).json({ status: 'ignored', reason: 'not an issue_updated event' });
  }

  // Filter: check if OCR-EXTRACTION label was just added
  const labelAdded = changelog.some(item =>
    item.field === 'labels' &&
    item.toString && item.toString.includes(TRIGGER_LABEL) &&
    (!item.fromString || !item.fromString.includes(TRIGGER_LABEL))
  );

  const hasLabel = labels.includes(TRIGGER_LABEL);

  if (!hasLabel && !labelAdded) {
    console.log(`${c.grey}⊘${c.reset}  Ignoring: ticket does not have label "${TRIGGER_LABEL}"`);
    return res.status(200).json({ status: 'ignored', reason: `no ${TRIGGER_LABEL} label` });
  }

  // Deduplication
  const eventId = `${issueKey}-${body.timestamp || Date.now()}`;
  if (isDuplicate(eventId)) {
    console.log(`${c.yellow}⚠${c.reset}  Duplicate event — skipping`);
    return res.status(200).json({ status: 'duplicate' });
  }

  // Respond immediately (async processing)
  res.status(202).json({
    status: 'accepted',
    ticketId: issueKey,
    message: `Processing ${issueKey} via Flowise agentic flow`
  });

  // Trigger Flowise asynchronously
  console.log(`${c.green}✔${c.reset}  ${c.bold}Triggering Flowise for ${issueKey}${c.reset}`);

  try {
    const result = await triggerFlowise(issueKey);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`${c.green}✔${c.reset}  ${c.bold}Pipeline complete for ${issueKey}${c.reset} (${elapsed}s)`);

    if (result?.text) {
      const preview = result.text.substring(0, 200).replace(/\n/g, ' ');
      console.log(`${c.grey}   Result: ${preview}...${c.reset}`);
    }
  } catch (err) {
    console.error(`${c.red}✘${c.reset}  Pipeline failed for ${issueKey}: ${err.message}`);
    if (err.response?.data) {
      console.error(`${c.grey}   Response: ${JSON.stringify(err.response.data).substring(0, 300)}${c.reset}`);
    }
  }
});

// Catch-all for Confluence webhook events (future use)
app.post('/webhook/confluence', (req, res) => {
  console.log(`${c.magenta}⟳${c.reset}  Confluence webhook received — ${req.body?.webhookEvent || 'unknown event'}`);
  res.status(200).json({ status: 'received' });
});

// PDF OCR Endpoint (bypasses Flowise vm2 sandbox)
app.post('/api/ocr', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Missing attachment URL' });
    
    console.log(`${c.cyan}ℹ${c.reset}  Downloading and scanning PDF: ${url}`);
    
    const auth = 'Basic ' + Buffer.from(process.env.ATLASSIAN_EMAIL + ':' + process.env.ATLASSIAN_TOKEN).toString('base64');
    
    const fileResponse = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: { 'Authorization': auth }
    });
    
    const pdfParse = (await import('pdf-parse')).default;
    const pdfData = await pdfParse(Buffer.from(fileResponse.data));
    
    if (pdfData.text && pdfData.text.trim().length > 10) {
      console.log(`${c.green}✔${c.reset}  PDF text extracted successfully`);
      res.json({ text: pdfData.text });
    } else {
      console.log(`${c.yellow}⚠${c.reset}  PDF contains no standard text (might be a scanned image)`);
      res.status(400).json({ error: 'No readable text in PDF.' });
    }
  } catch (error) {
    console.error(`${c.red}✘${c.reset}  OCR Failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ─── Server Startup ──────────────────────────────────────────────────────────
const server = app.listen(PORT, "127.0.0.1", () => {
  console.log(`\n${c.bold}${c.green}╔═══════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}${c.green}║   🤖 Flowise OCR Webhook Server                  ║${c.reset}`);
  console.log(`${c.bold}${c.green}╠═══════════════════════════════════════════════════╣${c.reset}`);
  console.log(`${c.bold}${c.green}║${c.reset}   Port:          ${c.cyan}${PORT}${c.reset}`);
  console.log(`${c.bold}${c.green}║${c.reset}   Jira endpoint:  ${c.cyan}POST /webhook/jira${c.reset}`);
  console.log(`${c.bold}${c.green}║${c.reset}   Health:         ${c.cyan}GET  /health${c.reset}`);
  console.log(`${c.bold}${c.green}║${c.reset}   Flowise:        ${c.cyan}${FLOWISE_HOST}${c.reset}`);
  console.log(`${c.bold}${c.green}║${c.reset}   Chatflow ID:    ${CHATFLOW_ID ? `${c.green}✓ set${c.reset}` : `${c.red}✗ NOT SET${c.reset}`}`);
  console.log(`${c.bold}${c.green}║${c.reset}   Trigger label:  ${c.yellow}${TRIGGER_LABEL}${c.reset}`);
  console.log(`${c.bold}${c.green}║${c.reset}   Transition ID:  ${c.yellow}${TRANSITION_ID}${c.reset}`);
  console.log(`${c.bold}${c.green}║${c.reset}   Webhook secret: ${WEBHOOK_SECRET ? `${c.green}✓ set${c.reset}` : `${c.yellow}⚠ not set (optional)${c.reset}`}`);
  console.log(`${c.bold}${c.green}╚═══════════════════════════════════════════════════╝${c.reset}`);
  console.log(`\n${c.grey}For local dev, run: ${c.cyan}ngrok http ${PORT}${c.reset}`);
  console.log(`${c.grey}Then register the ngrok URL as your Jira webhook target.${c.reset}\n`);
  console.log(`${c.grey}Waiting for webhook events...${c.reset}\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log(`\n${c.yellow}⚠${c.reset}  Shutting down webhook server...`);
  server.close(() => {
    console.log(`${c.green}✔${c.reset}  Server stopped.`);
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
