#!/usr/bin/env node
/**
 * ocr-agent.js — Standalone OCR Pipeline (No Flowise Required)
 *
 * Usage:
 *   node ocr-agent.js <JIRA_TICKET_ID> <FILE_PATH> [--dry-run] [--close]
 *   node ocr-agent.js --poll [--dry-run] [--close]
 *
 * Examples:
 *   node ocr-agent.js OCR-42 ./invoice.pdf --close
 *   node ocr-agent.js --poll --close   (auto-process + auto-close all OCR-EXTRACTION tickets)
 *
 * Differences from trigger.js:
 *   - Uses OpenAI API directly (no Flowise dependency)
 *   - Supports --poll mode to auto-discover all OCR-EXTRACTION tickets
 *   - Downloads Jira attachments automatically in poll mode
 *   - --close transitions tickets to Done after processing
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import FormData from 'form-data';

// ─── Config ──────────────────────────────────────────────────────────────────
const TRIGGER_LABEL  = process.env.JIRA_TRIGGER_LABEL    || 'OCR-EXTRACTION';
const TRANSITION_ID  = process.env.JIRA_DONE_TRANSITION_ID || '31';
const PROJECT_KEY    = process.env.JIRA_PROJECT_KEY       || 'OCR';
const SPACE_KEY      = process.env.CONFLUENCE_SPACE_KEY   || 'OCR';

// ─── Colour helpers ──────────────────────────────────────────────────────────
const c = { reset:'\x1b[0m', bold:'\x1b[1m', green:'\x1b[32m', yellow:'\x1b[33m', red:'\x1b[31m', cyan:'\x1b[36m', grey:'\x1b[90m', magenta:'\x1b[35m' };
const log = {
  info:  (m) => console.log(`${c.cyan}ℹ${c.reset}  ${m}`),
  ok:    (m) => console.log(`${c.green}✔${c.reset}  ${m}`),
  warn:  (m) => console.log(`${c.yellow}⚠${c.reset}  ${m}`),
  err:   (m) => console.error(`${c.red}✘${c.reset}  ${m}`),
  step:  (n, m) => console.log(`\n${c.bold}${c.cyan}[${n}]${c.reset} ${c.bold}${m}${c.reset}`),
  poll:  (m) => console.log(`${c.magenta}⟳${c.reset}  ${m}`)
};

// ─── Validate env ────────────────────────────────────────────────────────────
function validateEnv() {
  const required = ['ATLASSIAN_HOST', 'ATLASSIAN_EMAIL', 'ATLASSIAN_TOKEN'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(', ')}`);
}

// ─── Auth ────────────────────────────────────────────────────────────────────
function jiraHeaders() {
  const b64 = Buffer.from(`${process.env.ATLASSIAN_EMAIL}:${process.env.ATLASSIAN_TOKEN}`).toString('base64');
  return { Authorization: `Basic ${b64}`, 'Content-Type': 'application/json', Accept: 'application/json' };
}

// ─── Fetch Jira ticket ──────────────────────────────────────────────────────
async function fetchJiraTicket(ticketId) {
  const url = `${process.env.ATLASSIAN_HOST}/rest/api/3/issue/${ticketId}?fields=summary,status,labels,attachment`;
  const res = await axios.get(url, { headers: jiraHeaders() });
  return res.data;
}

// ─── Poll for OCR-EXTRACTION tickets ─────────────────────────────────────────
async function pollOcrTickets() {
  log.poll(`Searching for pending ${TRIGGER_LABEL} tickets...`);
  const jql = encodeURIComponent(`project = ${PROJECT_KEY} AND labels = "${TRIGGER_LABEL}" AND status != "Done" ORDER BY created ASC`);
  const url = `${process.env.ATLASSIAN_HOST}/rest/api/3/search?jql=${jql}&fields=summary,status,labels,attachment&maxResults=50`;
  const res = await axios.get(url, { headers: jiraHeaders() });
  const issues = res.data?.issues ?? [];
  log.poll(`Found ${issues.length} ticket(s)`);
  return issues;
}

// ─── Download attachment ─────────────────────────────────────────────────────
async function downloadAttachment(attachment) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-ocr-'));
  const dest = path.join(tmpDir, attachment.filename);
  const res = await axios.get(attachment.content, { responseType: 'stream', headers: jiraHeaders() });
  const writer = fs.createWriteStream(dest);
  await new Promise((resolve, reject) => { res.data.pipe(writer); writer.on('finish', resolve); writer.on('error', reject); });
  return dest;
}

// ─── OCR ─────────────────────────────────────────────────────────────────────
async function ocrFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (process.env.UNSTRUCTURED_API_KEY) {
    log.info('Using Unstructured.io (hi_res)...');
    const form = new FormData();
    form.append('files', fs.createReadStream(filePath), path.basename(filePath));
    form.append('strategy', 'hi_res');
    const res = await axios.post(
      process.env.UNSTRUCTURED_API_URL || 'https://api.unstructured.io/general/v0/general',
      form,
      { headers: { ...form.getHeaders(), 'unstructured-api-key': process.env.UNSTRUCTURED_API_KEY }, maxBodyLength: Infinity, timeout: 120_000 }
    );
    const text = (res.data || []).filter(el => el.text?.trim()).map(el => el.text.trim()).join('\n');
    return { text, source: 'unstructured.io' };
  }

  if (ext === '.pdf') {
    log.warn('Fallback: pdf-parse');
    const { default: pdfParse } = await import('pdf-parse');
    const data = await pdfParse(fs.readFileSync(filePath));
    return { text: data.text.trim(), source: 'pdf-parse' };
  }

  if (['.png','.jpg','.jpeg','.tiff','.bmp','.webp'].includes(ext)) {
    log.warn('Fallback: OpenAI Vision');
    const { default: OpenAI } = await import('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const mime = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.tiff':'image/tiff','.bmp':'image/bmp','.webp':'image/webp' }[ext] || 'image/jpeg';
    const b64 = fs.readFileSync(filePath).toString('base64');
    const res = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role:'user', content:[
        { type:'text', text:'Extract ALL text from this image exactly as it appears.' },
        { type:'image_url', image_url:{ url:`data:${mime};base64,${b64}`, detail:'high' } }
      ]}], max_tokens: 4096
    });
    return { text: res.choices[0].message.content.trim(), source: 'openai-vision' };
  }

  throw new Error(`Unsupported file type: ${ext}`);
}

// ─── Summarise ───────────────────────────────────────────────────────────────
async function summarise(ticketId, filename, ocrText) {
  if (!process.env.OPENAI_API_KEY) { log.warn('No OPENAI_API_KEY'); return ocrText.substring(0, 2000); }
  const { default: OpenAI } = await import('openai');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await openai.chat.completions.create({
    model: 'gpt-4o', temperature: 0.2,
    messages: [
      { role: 'system', content: `You are an OCR processing agent. Clean and structure the extracted text.\nSummarise in 3-5 bullets. Identify key entities.\nOutput:\nTICKET: {ticket_id}\nFILE: {filename}\nOCR STATUS: Complete / Partial / Failed\nSUMMARY:\n• bullet\nKEY ENTITIES: comma-separated\n\nFULL CLEANED TEXT:\n<cleaned text>\n\nIf low confidence: ⚠ Low confidence — manual review recommended.` },
      { role: 'user', content: `TICKET: ${ticketId}\nFILE: ${filename}\n\n--- OCR TEXT ---\n${ocrText.substring(0, 8000)}\n--- END ---` }
    ]
  });
  return res.choices[0].message.content.trim();
}

// ─── Post Jira Comment ───────────────────────────────────────────────────────
async function postJiraComment(ticketId, text) {
  const url = `${process.env.ATLASSIAN_HOST}/rest/api/3/issue/${ticketId}/comment`;
  const res = await axios.post(url, {
    body: { type: 'doc', version: 1, content: [
      { type:'heading', attrs:{ level:3 }, content:[{ type:'text', text:'🤖 OCR Automation Result' }] },
      { type:'codeBlock', attrs:{ language:'text' }, content:[{ type:'text', text }] },
      { type:'paragraph', content:[{ type:'text', text:`Processed by OCR Agent at ${new Date().toISOString()}`, marks:[{ type:'em' }] }] }
    ]}
  }, { headers: jiraHeaders() });
  return res.data?.id;
}

// ─── Post Failure Comment ────────────────────────────────────────────────────
async function postFailureComment(ticketId, reason) {
  try {
    await axios.post(`${process.env.ATLASSIAN_HOST}/rest/api/3/issue/${ticketId}/comment`, {
      body: { type:'doc', version:1, content:[
        { type:'heading', attrs:{ level:3 }, content:[{ type:'text', text:'❌ OCR Automation Failed' }] },
        { type:'paragraph', content:[{ type:'text', text:`Reason: ${reason}` }] }
      ]}
    }, { headers: jiraHeaders() });
  } catch (e) { log.err(`Could not post failure comment: ${e.message}`); }
}

// ─── Transition Ticket to Done ───────────────────────────────────────────────
async function transitionTicket(ticketId) {
  log.step('Close', `Transitioning ${ticketId} to Done`);
  const url = `${process.env.ATLASSIAN_HOST}/rest/api/3/issue/${ticketId}/transitions`;

  try {
    await axios.post(url, { transition: { id: TRANSITION_ID } }, { headers: jiraHeaders() });
    log.ok(`Ticket ${ticketId} → Done (transition ID: ${TRANSITION_ID})`);
    return true;
  } catch (e) {
    if (e.response?.status === 400) {
      log.warn(`Transition ID ${TRANSITION_ID} invalid. Auto-discovering...`);
      try {
        const transRes = await axios.get(url, { headers: jiraHeaders() });
        const transitions = transRes.data?.transitions || [];
        const done = transitions.find(t =>
          t.name.toLowerCase().includes('done') || t.name.toLowerCase().includes('close') || t.name.toLowerCase().includes('resolve')
        );
        if (done) {
          await axios.post(url, { transition: { id: done.id } }, { headers: jiraHeaders() });
          log.ok(`Ticket ${ticketId} → "${done.name}" (ID: ${done.id})`);
          log.info(`Set JIRA_DONE_TRANSITION_ID=${done.id} in .env`);
          return true;
        }
        log.warn(`Transitions available: ${transitions.map(t => `${t.name}(${t.id})`).join(', ')}`);
      } catch (err) { log.err(`Discovery failed: ${err.message}`); }
    }
    log.err(`Transition failed: ${e.message}`);
    return false;
  }
}

// ─── Confluence ──────────────────────────────────────────────────────────────
async function upsertConfluencePage(ticketId, filename, ocrText, summary) {
  const host = process.env.ATLASSIAN_HOST;
  const pageTitle = `OCR: ${ticketId} — ${filename}`;
  const html = `<h2>OCR Result</h2><p><strong>Ticket:</strong> <a href="${host}/browse/${ticketId}">${ticketId}</a></p><p><strong>File:</strong> ${filename}</p><p><strong>Processed:</strong> ${new Date().toISOString()}</p><hr/><h3>Summary</h3><pre>${summary}</pre><hr/><h3>Full Text</h3><pre>${ocrText.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`;

  const searchUrl = `${host}/wiki/rest/api/content?title=${encodeURIComponent(pageTitle)}&spaceKey=${SPACE_KEY}&expand=version`;
  const searchRes = await axios.get(searchUrl, { headers: jiraHeaders() });
  const existing = searchRes.data?.results?.[0];

  if (existing) {
    const res = await axios.put(`${host}/wiki/rest/api/content/${existing.id}`, {
      version: { number: (existing.version?.number ?? 1) + 1 },
      title: pageTitle, type: 'page',
      body: { storage: { value: html, representation: 'storage' } }
    }, { headers: jiraHeaders() });
    return `${host}/wiki${res.data._links?.webui || ''}`;
  } else {
    const res = await axios.post(`${host}/wiki/rest/api/content`, {
      type: 'page', title: pageTitle, space: { key: SPACE_KEY },
      body: { storage: { value: html, representation: 'storage' } }
    }, { headers: jiraHeaders() });
    return `${host}/wiki${res.data._links?.webui || ''}`;
  }
}

// ─── Process single ticket + file ────────────────────────────────────────────
async function processTicket(ticketId, filePath, dryRun = false, autoClose = false) {
  const filename = path.basename(filePath);
  log.info(`Processing ${ticketId} ← ${filename}`);

  try {
    log.step('OCR', `Running on ${filename}`);
    const { text, source } = await ocrFile(filePath);
    if (!text || text.trim().length < 5) throw new Error('OCR produced insufficient text');
    log.ok(`${text.length} chars via ${source}`);

    log.step('LLM', 'Summarising');
    const summary = await summarise(ticketId, filename, text);
    console.log(`\n${c.grey}── Summary ──────────────────────────────${c.reset}\n${summary}\n${c.grey}─────────────────────────────────────────${c.reset}\n`);

    if (dryRun) { log.warn('Dry run — skipping writes'); return; }

    log.step('Jira', 'Posting comment');
    const commentId = await postJiraComment(ticketId, summary);
    log.ok(`Comment ID: ${commentId}`);

    log.step('Confluence', 'Upserting page');
    const pageUrl = await upsertConfluencePage(ticketId, filename, text, summary);
    log.ok(`Page: ${pageUrl}`);

    let transitioned = false;
    if (autoClose) {
      transitioned = await transitionTicket(ticketId);
    }

    console.log(`\n${c.bold}${c.green}✅ Done:${c.reset} ${ticketId} — comment ${commentId} — ${pageUrl}${transitioned ? ' — ticket CLOSED' : ''}\n`);
  } catch (err) {
    log.err(`Failed (${ticketId}): ${err.message}`);
    if (!dryRun) await postFailureComment(ticketId, err.message);
  }
}

// ─── Poll mode ───────────────────────────────────────────────────────────────
async function runPollMode(dryRun, autoClose) {
  const issues = await pollOcrTickets();
  if (!issues.length) { log.info('No pending tickets.'); return; }

  for (const issue of issues) {
    const ticketId = issue.key;
    const attachments = issue.fields?.attachment ?? [];

    if (!attachments.length) {
      log.warn(`${ticketId}: no attachments — skipping`);
      if (!dryRun) await postFailureComment(ticketId, 'No attachments found');
      continue;
    }

    for (const att of attachments) {
      const ext = path.extname(att.filename).toLowerCase();
      if (!['.pdf','.png','.jpg','.jpeg','.tiff','.bmp','.webp'].includes(ext)) {
        log.warn(`${ticketId}: Skipping ${att.filename} (unsupported type)`);
        continue;
      }

      log.poll(`Downloading ${att.filename} from ${ticketId}...`);
      try {
        const tmpPath = await downloadAttachment(att);
        await processTicket(ticketId, tmpPath, dryRun, autoClose);
        fs.rmSync(path.dirname(tmpPath), { recursive: true, force: true });
      } catch (e) {
        log.err(`Download failed (${ticketId}/${att.filename}): ${e.message}`);
      }
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const args      = process.argv.slice(2);
  const dryRun    = args.includes('--dry-run');
  const poll      = args.includes('--poll');
  const autoClose = args.includes('--close');
  const cleaned   = args.filter(a => !a.startsWith('--'));

  console.log(`\n${c.bold}${c.magenta}╔════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}${c.magenta}║   OCR Agent — Standalone Pipeline v2       ║${c.reset}`);
  console.log(`${c.bold}${c.magenta}╚════════════════════════════════════════════╝${c.reset}\n`);

  if (autoClose) log.info(`Auto-close enabled (transition ID: ${TRANSITION_ID})`);

  try {
    validateEnv();
    if (poll) {
      await runPollMode(dryRun, autoClose);
    } else {
      if (cleaned.length < 2) {
        console.error('Usage: node ocr-agent.js <TICKET_ID> <FILE_PATH> [--dry-run] [--close]');
        console.error('       node ocr-agent.js --poll [--dry-run] [--close]');
        process.exit(1);
      }
      await processTicket(cleaned[0], cleaned[1], dryRun, autoClose);
    }
  } catch (e) { log.err(e.message); process.exit(1); }
}

main();
