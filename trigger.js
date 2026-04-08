#!/usr/bin/env node
/**
 * trigger.js — Flowise OCR Automation CLI Runner
 *
 * Usage:
 *   node trigger.js <JIRA_TICKET_ID> <FILE_PATH> [--dry-run] [--close]
 *   node trigger.js --webhook                   (starts webhook server)
 *
 * Examples:
 *   node trigger.js OCR-42 ./sample_invoice.pdf
 *   node trigger.js OCR-42 ./sample_invoice.pdf --close   (auto-close ticket)
 *   node trigger.js --webhook                              (start webhook mode)
 *
 * What it does:
 *   1. Validates the Jira ticket exists and has label "OCR-EXTRACTION"
 *   2. Uploads the file to Unstructured.io (hi_res strategy)
 *   3. Sends extracted text to Flowise for LLM summarisation
 *   4. Posts the structured result as a comment on the Jira ticket
 *   5. Creates or updates a Confluence page in the OCR space
 *   6. (--close) Transitions the ticket to "Done"
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';

// ─── Colour helpers ─────────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', grey: '\x1b[90m', magenta: '\x1b[35m'
};
const log = {
  info: (msg) => console.log(`${c.cyan}ℹ${c.reset}  ${msg}`),
  ok:   (msg) => console.log(`${c.green}✔${c.reset}  ${msg}`),
  warn: (msg) => console.log(`${c.yellow}⚠${c.reset}  ${msg}`),
  err:  (msg) => console.error(`${c.red}✘${c.reset}  ${msg}`),
  step: (n, msg) => console.log(`\n${c.bold}${c.cyan}[Step ${n}]${c.reset} ${c.bold}${msg}${c.reset}`)
};

// ─── Config ──────────────────────────────────────────────────────────────────
const config = {
  flowise: {
    host:       process.env.FLOWISE_HOST       || 'http://localhost:3000',
    username:   process.env.FLOWISE_USERNAME   || '',
    password:   process.env.FLOWISE_PASSWORD   || '',
    chatflowId: process.env.FLOWISE_CHATFLOW_ID || ''
  },
  atlassian: {
    host:  process.env.ATLASSIAN_HOST  || '',
    email: process.env.ATLASSIAN_EMAIL || '',
    token: process.env.ATLASSIAN_TOKEN || ''
  },
  unstructured: {
    apiKey: process.env.UNSTRUCTURED_API_KEY || '',
    apiUrl: process.env.UNSTRUCTURED_API_URL || 'https://api.unstructured.io/general/v0/general'
  },
  confluence: {
    spaceKey: process.env.CONFLUENCE_SPACE_KEY || 'OCR'
  },
  jira: {
    triggerLabel:    process.env.JIRA_TRIGGER_LABEL    || 'OCR-EXTRACTION',
    transitionId:   process.env.JIRA_DONE_TRANSITION_ID || '31',
    projectKey:     process.env.JIRA_PROJECT_KEY       || 'OCR'
  }
};

// ─── Atlassian Auth Helper ───────────────────────────────────────────────────
function atlassianAuth() {
  const b64 = Buffer.from(`${config.atlassian.email}:${config.atlassian.token}`).toString('base64');
  return `Basic ${b64}`;
}

// ─── Step 1: Validate Jira Ticket ────────────────────────────────────────────
async function validateJiraTicket(ticketId) {
  log.step(1, `Fetching Jira ticket ${ticketId}`);

  if (!config.atlassian.host || !config.atlassian.email || !config.atlassian.token) {
    throw new Error('Missing ATLASSIAN_HOST / ATLASSIAN_EMAIL / ATLASSIAN_TOKEN in .env');
  }

  const url = `${config.atlassian.host}/rest/api/3/issue/${ticketId}`;
  const res = await axios.get(url, {
    headers: { Authorization: atlassianAuth(), Accept: 'application/json' }
  });

  const issue = res.data;
  const labels  = issue.fields?.labels ?? [];
  const summary = issue.fields?.summary ?? '(no summary)';
  const status  = issue.fields?.status?.name ?? 'Unknown';

  log.ok(`Found: "${summary}" [${status}]`);
  log.info(`Labels: ${labels.length ? labels.join(', ') : '(none)'}`);

  if (!labels.includes(config.jira.triggerLabel)) {
    log.warn(`Ticket ${ticketId} does NOT have label "${config.jira.triggerLabel}". Proceeding anyway...`);
  }

  return { issue, summary, labels, status };
}

// ─── Step 2: OCR via Unstructured.io (with fallbacks) ────────────────────────
async function extractTextWithUnstructured(filePath) {
  log.step(2, `Running OCR on ${path.basename(filePath)}`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  // Unstructured.io API
  if (config.unstructured.apiKey) {
    log.info('Using Unstructured.io API (hi_res strategy)...');
    const form = new FormData();
    form.append('files', fs.createReadStream(filePath), path.basename(filePath));
    form.append('strategy', 'hi_res');
    form.append('output_format', 'application/json');

    const res = await axios.post(config.unstructured.apiUrl, form, {
      headers: { ...form.getHeaders(), 'unstructured-api-key': config.unstructured.apiKey },
      maxBodyLength: Infinity, timeout: 120_000
    });

    const elements = res.data;
    if (!Array.isArray(elements) || elements.length === 0) {
      throw new Error('Unstructured.io returned no elements');
    }

    const text = elements.filter(el => el.text?.trim()).map(el => el.text.trim()).join('\n');
    const pageCount = new Set(elements.map(el => el.metadata?.page_number)).size;
    log.ok(`Extracted ${elements.length} elements across ${pageCount} page(s)`);
    return { text, elementCount: elements.length, pageCount, source: 'unstructured' };
  }

  // PDF fallback
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    log.warn('No UNSTRUCTURED_API_KEY — falling back to pdf-parse');
    const { default: pdfParse } = await import('pdf-parse');
    const data = await pdfParse(fs.readFileSync(filePath));
    log.ok(`pdf-parse: ${data.text.length} chars from ${data.numpages} page(s)`);
    return { text: data.text.trim(), elementCount: 1, pageCount: data.numpages, source: 'pdf-parse' };
  }

  // Image fallback — OpenAI Vision
  if (['.png', '.jpg', '.jpeg', '.tiff', '.bmp', '.webp'].includes(ext)) {
    log.warn('No UNSTRUCTURED_API_KEY — falling back to OpenAI Vision');
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY required for image OCR fallback');
    const { default: OpenAI } = await import('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const mimeMap = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.tiff':'image/tiff','.bmp':'image/bmp','.webp':'image/webp' };
    const base64 = fs.readFileSync(filePath).toString('base64');
    const res = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Extract ALL text visible in this image exactly as it appears. Output only the extracted text.' },
        { type: 'image_url', image_url: { url: `data:${mimeMap[ext] || 'image/jpeg'};base64,${base64}`, detail: 'high' } }
      ]}],
      max_tokens: 4096
    });
    const text = res.choices[0].message.content.trim();
    log.ok(`OpenAI Vision: ${text.length} chars`);
    return { text, elementCount: 1, pageCount: 1, source: 'openai-vision' };
  }

  throw new Error(`Unsupported file type: ${ext}`);
}

// ─── Step 3: Summarise via Flowise ───────────────────────────────────────────
async function summariseWithFlowise(ticketId, filename, ocrText) {
  log.step(3, 'Sending extracted text to Flowise for LLM summarisation');

  if (!config.flowise.chatflowId) {
    throw new Error('FLOWISE_CHATFLOW_ID not set — import flowise-flow.json first');
  }

  const question = `Process OCR text for ticket ${ticketId}, file ${filename}.\nTransition ID for Done: ${config.jira.transitionId}\n\n--- EXTRACTED OCR TEXT ---\n${ocrText.substring(0, 8000)}\n--- END ---`;
  const headers = { 'Content-Type': 'application/json' };
  if (config.flowise.username && config.flowise.password) {
    headers['Authorization'] = `Basic ${Buffer.from(`${config.flowise.username}:${config.flowise.password}`).toString('base64')}`;
  }

  const url = `${config.flowise.host}/api/v1/prediction/${config.flowise.chatflowId}`;
  log.info(`POST ${url}`);

  const res = await axios.post(url, {
    question,
    overrideConfig: { sessionId: `${ticketId}-${Date.now()}` }
  }, { headers, timeout: 120_000 });

  const result = res.data?.text || res.data?.answer || JSON.stringify(res.data);
  log.ok('Flowise returned structured summary');
  return result;
}

// ─── Step 3b: Fallback via OpenAI directly ───────────────────────────────────
async function summariseWithOpenAI(ticketId, filename, ocrText) {
  log.warn('Flowise not available — using OpenAI directly');
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY required');
  const { default: OpenAI } = await import('openai');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const res = await openai.chat.completions.create({
    model: 'gpt-4o', temperature: 0.2,
    messages: [
      { role: 'system', content: `You are an OCR processing agent. Clean and structure the extracted text.\nSummarise in 3-5 bullet points. Identify key entities.\nOutput:\nTICKET: {ticket_id}\nFILE: {filename}\nOCR STATUS: Complete / Partial / Failed\nSUMMARY: (bullets)\nKEY ENTITIES: (comma-separated)\nIf confidence is low: ⚠ Low confidence — manual review recommended.` },
      { role: 'user', content: `TICKET: ${ticketId}\nFILE: ${filename}\n\n--- OCR TEXT ---\n${ocrText.substring(0, 8000)}\n--- END ---` }
    ]
  });
  return res.choices[0].message.content.trim();
}

// ─── Step 4: Post Jira Comment ───────────────────────────────────────────────
async function postJiraComment(ticketId, commentText) {
  log.step(4, `Posting comment on ${ticketId}`);
  const url = `${config.atlassian.host}/rest/api/3/issue/${ticketId}/comment`;
  const body = {
    body: {
      type: 'doc', version: 1,
      content: [
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '🤖 OCR Automation Result' }] },
        { type: 'codeBlock', attrs: { language: 'text' }, content: [{ type: 'text', text: commentText }] },
        { type: 'paragraph', content: [
          { type: 'text', text: `Processed by Flowise OCR Agent at ${new Date().toISOString()}`, marks: [{ type: 'em' }] }
        ]}
      ]
    }
  };
  const res = await axios.post(url, body, {
    headers: { Authorization: atlassianAuth(), 'Content-Type': 'application/json' }
  });
  log.ok(`Comment posted! ID: ${res.data?.id}`);
  return { commentId: res.data?.id, commentUrl: `${config.atlassian.host}/browse/${ticketId}` };
}

// ─── Step 4b: Post Failure Comment ───────────────────────────────────────────
async function postJiraFailureComment(ticketId, reason) {
  log.warn(`Posting failure comment on ${ticketId}`);
  try {
    const url = `${config.atlassian.host}/rest/api/3/issue/${ticketId}/comment`;
    await axios.post(url, {
      body: {
        type: 'doc', version: 1,
        content: [
          { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '❌ OCR Automation Failed' }] },
          { type: 'paragraph', content: [{ type: 'text', text: `Reason: ${reason}` }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Please process manually or re-trigger.', marks: [{ type: 'em' }] }] }
        ]
      }
    }, { headers: { Authorization: atlassianAuth(), 'Content-Type': 'application/json' } });
    log.ok('Failure comment posted');
  } catch (e) {
    log.err(`Could not post failure comment: ${e.message}`);
  }
}

// ─── Step 5: Confluence Page ─────────────────────────────────────────────────
async function upsertConfluencePage(ticketId, filename, ocrText, summary) {
  log.step(5, `Creating/updating Confluence page for ${ticketId}`);
  const host = config.atlassian.host;
  const spaceKey = config.confluence.spaceKey;
  const pageTitle = `OCR: ${ticketId} — ${filename}`;

  const htmlContent = `
<h2>OCR Automation Result</h2>
<p><strong>Ticket:</strong> <a href="${host}/browse/${ticketId}">${ticketId}</a></p>
<p><strong>File:</strong> ${filename}</p>
<p><strong>Processed:</strong> ${new Date().toISOString()}</p>
<hr/><h3>Summary</h3><pre>${summary}</pre>
<hr/><h3>Full Extracted Text</h3>
<pre>${ocrText.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`.trim();

  const searchUrl = `${host}/wiki/rest/api/content?title=${encodeURIComponent(pageTitle)}&spaceKey=${spaceKey}&expand=version`;
  const searchRes = await axios.get(searchUrl, { headers: { Authorization: atlassianAuth(), Accept: 'application/json' } });
  const existing = searchRes.data?.results?.[0];

  if (existing) {
    const res = await axios.put(`${host}/wiki/rest/api/content/${existing.id}`, {
      version: { number: (existing.version?.number ?? 1) + 1 },
      title: pageTitle, type: 'page',
      body: { storage: { value: htmlContent, representation: 'storage' } }
    }, { headers: { Authorization: atlassianAuth(), 'Content-Type': 'application/json' } });
    const pageUrl = `${host}/wiki${res.data._links?.webui || ''}`;
    log.ok(`Confluence page UPDATED: ${pageUrl}`);
    return { action: 'updated', pageUrl };
  } else {
    const res = await axios.post(`${host}/wiki/rest/api/content`, {
      type: 'page', title: pageTitle, space: { key: spaceKey },
      body: { storage: { value: htmlContent, representation: 'storage' } }
    }, { headers: { Authorization: atlassianAuth(), 'Content-Type': 'application/json' } });
    const pageUrl = `${host}/wiki${res.data._links?.webui || ''}`;
    log.ok(`Confluence page CREATED: ${pageUrl}`);
    return { action: 'created', pageUrl };
  }
}

// ─── Step 6: Transition Ticket to Done ───────────────────────────────────────
async function transitionTicket(ticketId) {
  log.step(6, `Transitioning ${ticketId} to Done`);
  const transitionId = config.jira.transitionId;
  const url = `${config.atlassian.host}/rest/api/3/issue/${ticketId}/transitions`;

  try {
    await axios.post(url, {
      transition: { id: transitionId }
    }, { headers: { Authorization: atlassianAuth(), 'Content-Type': 'application/json' } });
    log.ok(`Ticket ${ticketId} transitioned to Done (transition ID: ${transitionId})`);
    return true;
  } catch (e) {
    if (e.response?.status === 400) {
      log.warn(`Transition ID ${transitionId} may be wrong. Attempting to discover correct ID...`);
      try {
        const transRes = await axios.get(url, { headers: { Authorization: atlassianAuth(), Accept: 'application/json' } });
        const transitions = transRes.data?.transitions || [];
        const doneTransition = transitions.find(t =>
          t.name.toLowerCase().includes('done') || t.name.toLowerCase().includes('close') || t.name.toLowerCase().includes('resolve')
        );
        if (doneTransition) {
          await axios.post(url, { transition: { id: doneTransition.id } }, {
            headers: { Authorization: atlassianAuth(), 'Content-Type': 'application/json' }
          });
          log.ok(`Ticket ${ticketId} transitioned to "${doneTransition.name}" (ID: ${doneTransition.id})`);
          log.info(`Tip: Set JIRA_DONE_TRANSITION_ID=${doneTransition.id} in .env for faster transitions`);
          return true;
        }
        log.warn(`Available transitions: ${transitions.map(t => `${t.name}(${t.id})`).join(', ')}`);
      } catch (discoverErr) {
        log.err(`Could not discover transitions: ${discoverErr.message}`);
      }
    }
    log.err(`Failed to transition ticket: ${e.message}`);
    return false;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  // Webhook mode
  if (args.includes('--webhook')) {
    console.log(`${c.cyan}ℹ${c.reset}  Starting webhook server...`);
    await import('./webhook-server.js');
    return;
  }

  const dryRun    = args.includes('--dry-run');
  const autoClose = args.includes('--close');
  const filtered  = args.filter(a => !a.startsWith('--'));

  console.log(`\n${c.bold}${c.cyan}╔══════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}${c.cyan}║   Flowise OCR Automation Pipeline v2         ║${c.reset}`);
  console.log(`${c.bold}${c.cyan}╚══════════════════════════════════════════════╝${c.reset}\n`);

  if (filtered.length < 2) {
    console.error(`Usage: node trigger.js <JIRA_TICKET_ID> <FILE_PATH> [--dry-run] [--close]`);
    console.error(`       node trigger.js --webhook\n`);
    process.exit(1);
  }

  const [ticketId, filePath] = filtered;
  const filename = path.basename(filePath);

  if (dryRun) log.warn('DRY RUN mode');
  if (autoClose) log.info('Auto-close enabled — will transition ticket to Done');

  let ocrResult, summary;

  try {
    await validateJiraTicket(ticketId);

    ocrResult = await extractTextWithUnstructured(filePath);
    if (!ocrResult.text || ocrResult.text.trim().length < 10) {
      throw new Error('OCR produced insufficient text');
    }
    log.info(`Extracted ${ocrResult.text.length} chars via ${ocrResult.source}`);

    try {
      summary = await summariseWithFlowise(ticketId, filename, ocrResult.text);
    } catch (flowiseErr) {
      log.warn(`Flowise error: ${flowiseErr.message}`);
      summary = await summariseWithOpenAI(ticketId, filename, ocrResult.text);
    }

    console.log(`\n${c.grey}─── LLM Output ────────────────────────────────────${c.reset}`);
    console.log(summary);
    console.log(`${c.grey}───────────────────────────────────────────────────${c.reset}\n`);

    if (dryRun) { log.warn('Dry run complete'); process.exit(0); }

    const { commentId, commentUrl } = await postJiraComment(ticketId, summary);
    const { action: confAction, pageUrl } = await upsertConfluencePage(ticketId, filename, ocrResult.text, summary);

    // Auto-close
    let transitioned = false;
    if (autoClose) {
      transitioned = await transitionTicket(ticketId);
    }

    console.log(`\n${c.bold}${c.green}╔══════════════════════════════════════════════╗${c.reset}`);
    console.log(`${c.bold}${c.green}║   ✅  Pipeline Complete                       ║${c.reset}`);
    console.log(`${c.bold}${c.green}╚══════════════════════════════════════════════╝${c.reset}`);
    console.log(`  Ticket:       ${config.atlassian.host}/browse/${ticketId}`);
    console.log(`  Comment:      ID ${commentId}`);
    console.log(`  Confluence:   ${confAction.toUpperCase()} — ${pageUrl}`);
    console.log(`  OCR Source:   ${ocrResult.source} (${ocrResult.text.length} chars)`);
    console.log(`  Auto-close:   ${transitioned ? '✅ Transitioned to Done' : autoClose ? '❌ Failed' : 'Not requested'}\n`);

  } catch (err) {
    log.err(`Pipeline failed: ${err.message}`);
    if (!dryRun && config.atlassian.host && config.atlassian.email && config.atlassian.token) {
      await postJiraFailureComment(filtered[0], err.message);
    }
    process.exit(1);
  }
}

main();
