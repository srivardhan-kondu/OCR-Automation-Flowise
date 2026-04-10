# 🤖 Flowise OCR Automation — Event-Driven Agentic Pipeline

> Jira ticket tagged `OCR-EXTRACTION` → Flowise Tool Agent → OCR → Jira comment + Confluence page → Ticket auto-closed

---

## Table of Contents

- [Architecture](#architecture)
- [Prerequisites Checklist](#prerequisites-checklist)
- [Part 1 — External Setup (Jira, Confluence, API Keys)](#part-1--external-setup-jira-confluence-api-keys)
- [Part 2 — Project Setup (Local)](#part-2--project-setup-local)
- [Part 3 — Flowise Setup](#part-3--flowise-setup)
- [Part 4 — Webhook Setup (Auto-Trigger)](#part-4--webhook-setup-auto-trigger)
- [Part 5 — Running the Pipeline](#part-5--running-the-pipeline)
- [Part 6 — End-to-End Test](#part-6--end-to-end-test)
- [Troubleshooting](#troubleshooting)

---

## Architecture

```
 ┌─────────────────────┐
 │   Jira Cloud        │
 │   ticket labeled    │──── webhook POST ────┐
 │   "OCR-EXTRACTION"  │                      │
 └─────────────────────┘                      ▼
                                 ┌───────────────────────┐
                                 │  webhook-server.js     │
                                 │  (Express, port 3001)  │
                                 │  • validates event     │
                                 │  • deduplicates        │
                                 │  • calls Flowise       │
                                 └──────────┬────────────┘
                                            │
                                            ▼
                              ╔═════════════════════════════╗
                              ║   Flowise Tool Agent        ║
                              ║   (GPT-4o + Function Calls) ║
                              ║                             ║
                              ║  🔧 Jira Tool (Issues)      ║
                              ║     getIssue, transitionIssue║
                              ║  🔧 Jira Tool (Comments)    ║
                              ║     createComment            ║
                              ║  🔧 Custom Tool (OCR)       ║
                              ║     Unstructured.io / fallback║
                              ║  🔧 Requests POST           ║
                              ║     Confluence page create   ║
                              ╚══════════════╤══════════════╝
                                             │
                        ┌────────────────────┼────────────────────┐
                        ▼                    ▼                    ▼
                  Jira Comment        Confluence Page       Ticket → Done
                  (OCR result)        (full text)           (auto-closed)
```

---

## Prerequisites Checklist

Before you begin, make sure you have access to/accounts on all of these:

| # | Requirement | Where to get it | Cost |
|---|------------|----------------|------|
| 1 | **Node.js ≥ 18** | [nodejs.org](https://nodejs.org/) | Free |
| 2 | **Atlassian Cloud account** | [atlassian.com](https://www.atlassian.com/try/cloud/signup) | Free tier available |
| 3 | **Jira Software** (Cloud) | Included with Atlassian account | Free for ≤10 users |
| 4 | **Confluence** (Cloud) | Included with Atlassian account | Free for ≤10 users |
| 5 | **Atlassian API Token** | [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens) | Free |
| 6 | **OpenAI API Key** | [platform.openai.com](https://platform.openai.com/api-keys) | Pay-as-you-go |
| 7 | **Unstructured.io API Key** (optional) | [unstructured.io](https://unstructured.io/api-key-hosted) | Free tier: 1000 pages/mo |
| 8 | **ngrok** (for local dev webhooks) | [ngrok.com](https://ngrok.com/) | Free tier available |

---

## Part 1 — External Setup (Jira, Confluence, API Keys)

### Step 1.1 — Create an Atlassian API Token

This token is used for all Jira and Confluence API calls.

1. Go to **[https://id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)**
2. Click **"Create API token"**
3. Give it a label: `Flowise OCR Automation`
4. Click **Create** → **Copy** the token immediately (you can't see it again)
5. Save it — you'll need it for `.env` as `ATLASSIAN_TOKEN`

> ⚠️ **Note**: Your Atlassian email (the one you log in with) goes in `ATLASSIAN_EMAIL`.  
> Your Atlassian site URL (e.g. `https://yourcompany.atlassian.net`) goes in `ATLASSIAN_HOST`.

---

### Step 1.2 — Create a Jira Project

1. Go to your Jira instance: `https://yourcompany.atlassian.net`
2. Click **Projects** → **Create project**
3. Choose **Scrum** or **Kanban** (either works)
4. Set:
   - **Name**: `OCR Processing` (or whatever you like)
   - **Key**: `OCR` ← **This must be `OCR`** (or change `JIRA_PROJECT_KEY` in `.env`)
5. Click **Create**

---

### Step 1.3 — Find Your "Done" Transition ID

Every Jira project has a workflow with transition IDs. We need the ID for "Done".

**Option A — via API (recommended):**
```bash
# Replace with your values
curl -s -u your@email.com:YOUR_API_TOKEN \
  "https://yourcompany.atlassian.net/rest/api/3/issue/OCR-1/transitions" \
  | python3 -m json.tool
```

> ⚠️ You need at least one ticket to exist. Create a dummy ticket first (see Step 1.4).

Look for the transition with name `"Done"` and note its `"id"` field. Common values: `31`, `41`, `21`.

**Option B — via Jira UI:**
1. Open any ticket in the OCR project
2. Open browser DevTools (F12) → Network tab
3. Click the "Done" button on the ticket
4. Look for a POST request to `/transitions` — the request body has the transition ID

Set this value as `JIRA_DONE_TRANSITION_ID` in your `.env`. If you get it wrong, **the system auto-discovers the correct one** at runtime.

---

### Step 1.4 — Create a Test Ticket in Jira

1. Go to the **OCR** project
2. Click **Create** (+ button)
3. Fill in:
   - **Summary**: `Test OCR extraction`
   - **Issue Type**: Task (or any)
4. **Attach a file**: Click the paperclip icon → upload a PDF or image (invoice, form, receipt, etc.)
5. **Add the label**: Click the "Label" field → type `OCR-EXTRACTION` → press Enter
6. Click **Create**

> 💡 The label **must be exactly `OCR-EXTRACTION`** (case-sensitive). This is what triggers the automation.

---

### Step 1.5 — Create a Confluence Space

1. Go to Confluence: `https://yourcompany.atlassian.net/wiki`
2. Click **Spaces** → **Create a space**
3. Choose **Blank space**
4. Set:
   - **Space name**: `OCR Results` (or anything)
   - **Space key**: `OCR` ← **This must be `OCR`** (or change `CONFLUENCE_SPACE_KEY` in `.env`)
5. Click **Create**

> 🔑 Make sure the account you're using (the one with the API token) has **Create Page** and **Edit Page** permissions in this space.

**To verify permissions:**
1. In the OCR space, click **Space settings** (gear icon)
2. Click **Permissions**
3. Ensure your user/group has: ☑ Add Pages, ☑ Edit Pages

---

### Step 1.6 — Get an OpenAI API Key

1. Go to **[https://platform.openai.com/api-keys](https://platform.openai.com/api-keys)**
2. Click **"Create new secret key"**
3. Name it: `Flowise OCR`
4. Copy the key (starts with `sk-proj-...`)
5. Save it for `.env` as `OPENAI_API_KEY`

> 💰 **Cost**: The pipeline uses GPT-4o. Typical cost per OCR processing: ~$0.01-0.05 per document (depends on length).  
> Make sure your OpenAI account has billing set up and sufficient credits.

---

### Step 1.7 — Get an Unstructured.io API Key (Optional but Recommended)

Unstructured.io provides the best OCR quality with its `hi_res` strategy. Without it, the system falls back to `pdf-parse` (text-only PDFs) or OpenAI Vision (images).

1. Go to **[https://unstructured.io](https://unstructured.io)**
2. Click **"Get API Key"** or **"Sign Up"**
3. Verify your email
4. Go to **Dashboard** → copy your API key
5. Save it for `.env` as `UNSTRUCTURED_API_KEY`

> 🆓 **Free tier**: 1,000 pages/month. No credit card required.

---

### Step 1.8 — Summary: What You Should Have Now

| Item | Example Value | Where it goes in `.env` |
|------|--------------|------------------------|
| Atlassian site URL | `https://mycompany.atlassian.net` | `ATLASSIAN_HOST` |
| Atlassian email | `john@mycompany.com` | `ATLASSIAN_EMAIL` |
| Atlassian API token | `ATATT3xF...` | `ATLASSIAN_TOKEN` |
| OpenAI API key | `sk-proj-abc123...` | `OPENAI_API_KEY` |
| Unstructured API key | `unstr_abc123...` | `UNSTRUCTURED_API_KEY` |
| Jira project key | `OCR` | `JIRA_PROJECT_KEY` |
| Done transition ID | `31` | `JIRA_DONE_TRANSITION_ID` |
| Confluence space key | `OCR` | `CONFLUENCE_SPACE_KEY` |

---

## Part 2 — Project Setup (Local)

### Step 2.1 — Clone / Enter the Project

```bash
cd /path/to/Flowise/ocr-automation
```

### Step 2.2 — Install Dependencies

```bash
npm install
```

Expected output: `added 97 packages, 0 vulnerabilities`

### Step 2.3 — Create Your `.env` File

```bash
cp .env.example .env
```

Now open `.env` in your editor and fill in **all** the values you collected in Part 1:

```env
# ─── Flowise ────────────────────────────────────────────────────────────────
FLOWISE_HOST=http://localhost:3000
FLOWISE_USERNAME=admin
FLOWISE_PASSWORD=1234
FLOWISE_CHATFLOW_ID=              # ← Fill after Part 3 (Flowise import)

# ─── Atlassian ───────────────────────────────────────────────────────────────
ATLASSIAN_HOST=https://yourcompany.atlassian.net    # ← Your Atlassian URL
ATLASSIAN_EMAIL=your@email.com                       # ← Your login email
ATLASSIAN_TOKEN=ATATT3xFfGF...                       # ← API token from Step 1.1

# ─── Unstructured.io ─────────────────────────────────────────────────────────
UNSTRUCTURED_API_KEY=unstr_...                       # ← From Step 1.7 (optional)
UNSTRUCTURED_API_URL=https://api.unstructured.io/general/v0/general

# ─── OpenAI ──────────────────────────────────────────────────────────────────
OPENAI_API_KEY=sk-proj-...                           # ← From Step 1.6

# ─── Jira ────────────────────────────────────────────────────────────────────
JIRA_PROJECT_KEY=OCR                                 # ← From Step 1.2
JIRA_TRIGGER_LABEL=OCR-EXTRACTION
JIRA_DONE_TRANSITION_ID=31                           # ← From Step 1.3

# ─── Confluence ──────────────────────────────────────────────────────────────
CONFLUENCE_SPACE_KEY=OCR                             # ← From Step 1.5

# ─── Webhook ─────────────────────────────────────────────────────────────────
WEBHOOK_PORT=3001
WEBHOOK_SECRET=                                      # ← Optional (leave blank for now)
```

---

## Part 3 — Flowise Setup

### Step 3.1 — Install Flowise

```bash
npm install -g flowise
```


### Step 3.2 — Start Flowise

```bash
npx flowise start
```

Flowise opens at **http://localhost:3000**.

- **First time setup:** Register a new admin account with your email and a password of your choice.
- **Subsequent runs:** Log in with the credentials you registered.

> **Note:** The `.env` file values for `FLOWISE_USERNAME` and `FLOWISE_PASSWORD` are for reference only. They do not automatically create a user. Each user must register their own admin account on first launch.

### Step 3.3 — Import the Custom Tools & Chatflow

1. Open **http://localhost:3000** in your browser
2. First, go to **Tools** in the left sidebar
3. Click **Load** (top right icon) and select all four JSON files located in the `tools/` folder.
4. Next, go to **Chatflows** in the left sidebar
5. Click **+ Add New** (top right)
6. Click the **⋮ menu** (three dots, top right) → **Load Chatflow**
7. Select the file: `flowise-flow.json`

### Step 3.4 — Configure the OpenAI Credential

1. Click the **ChatOpenAI** node on the canvas
2. In the panel, find **"Connect Credential"**
3. Click **"Create New"**
4. Set:
   - **Credential Name**: `OpenAI API Key`
   - **OpenAI API Key**: Paste your `sk-proj-...` key
5. Click **Add**

### Step 3.5 — Configure the Jira Credentials

You need to set up a **Jira API Credential** and apply it to BOTH Jira nodes.

1. Click the **Jira (Issues)** node
2. Find **"Connect Credential"** → **"Create New"**
3. Set:
   - **Credential Name**: `Jira API`
   - **Username**: Your Atlassian email (e.g. `john@mycompany.com`)
   - **Access Token**: Your Atlassian API token
4. Click **Add**
5. **Set the Host field**: `https://yourcompany.atlassian.net`
6. Now click the **Jira (Comments)** node
7. Select the **same credential** (`Jira API`) from the dropdown
8. **Set the Host field**: `https://yourcompany.atlassian.net`

### Step 3.6 — Register Custom Tool Variables in Flowise

Because Flowise custom tools run inside a protected sandbox, they use raw Javascript to make secure fetch requests. 

Instead of hardcoding your secrets into the tool codes, the tools are pre-configured to use **Flowise Variables** (`$vars`).

1. Go to **Flowise sidebar** → **Variables**
2. Click **+ Add New** and create the following three variables (set their Type to `String`):
   - **Variable Name**: `ATLASSIAN_EMAIL` | **Value**: Your login email (e.g. `john@company.com`)
   - **Variable Name**: `ATLASSIAN_TOKEN` | **Value**: Your Atlassian API token
   - **Variable Name**: `ATLASSIAN_HOST`  | **Value**: Your Atlassian site URL without a trailing slash (e.g. `https://yourcompany.atlassian.net`)
3. The custom tools will now securely and automatically pull these variables when executing!

### Step 3.8 — Save and Get the Chatflow ID

1. Click **Save** (top right of the canvas)
2. Look at the **browser URL bar**: `http://localhost:3000/chatflows/YOUR-CHATFLOW-UUID-HERE`
3. Copy that UUID
4. Paste it into your `.env` file as `FLOWISE_CHATFLOW_ID`

### Step 3.9 — Test the Flow Manually

1. On the chatflow page, you should see a **Chat** button (bottom right)
2. Click it and type: `Process Jira ticket OCR-1`
3. Watch the agent use its tools — you should see tool calls in the response
4. If it works, the flow is ready!

---

## Part 4 — Webhook Setup (Auto-Trigger)

This makes the pipeline trigger **automatically** when someone adds the `OCR-EXTRACTION` label.

### Step 4.1 — Start ngrok (Local Development Only)

Jira Cloud webhooks need a **publicly reachable URL**. For local dev, use ngrok:

```bash
# Install ngrok (if not installed)
npm install -g ngrok
# Or: brew install ngrok

# Start a tunnel to port 3001
ngrok http 3001
```

ngrok will print something like:
```
Forwarding:  https://a1b2c3d4.ngrok.io → http://localhost:3001
```

Copy the `https://...ngrok.io` URL — that's your webhook target.

### Step 4.2 — Register the Jira Webhook

**Option A — Using the setup script:**
```bash
node setup-webhook.js https://a1b2c3d4.ngrok.io/webhook/jira
```

**Option B — Manually via Jira Admin UI:**
1. Go to: `https://yourcompany.atlassian.net/plugins/servlet/webhooks`
   - Or: **Jira Settings** (gear icon) → **System** → **WebHooks**
2. Click **"Create a WebHook"**
3. Fill in:
   - **Name**: `Flowise OCR Automation`
   - **Status**: ☑ Enabled
   - **URL**: `https://a1b2c3d4.ngrok.io/webhook/jira`
   - **Events**: Scroll down → ☑ **Issue** → ☑ **updated**
   - **JQL filter** (optional): `project = OCR`
4. Click **Create**

> ⚠️ **Production**: Replace the ngrok URL with your actual server URL (e.g., a cloud VM, Railway, Render, etc.).

### Step 4.3 — Start the Webhook Server

```bash
npm run webhook
```

You'll see:
```
╔═══════════════════════════════════════════════════╗
║   🤖 Flowise OCR Webhook Server                  ║
╠═══════════════════════════════════════════════════╣
║   Port:          3001                             ║
║   Trigger label:  OCR-EXTRACTION                  ║
║   Chatflow ID:    ✓ set                           ║
╚═══════════════════════════════════════════════════╝

Waiting for webhook events...
```

---

## Part 5 — Running the Pipeline

### Three Modes

#### Mode 1: Webhook (Fully Automatic) ← Recommended for production

```bash
# Terminal 1: Start Flowise
npx flowise start --FLOWISE_USERNAME=admin --FLOWISE_PASSWORD=1234

# Terminal 2: Start ngrok (local dev only)
ngrok http 3001

# Terminal 3: Start webhook server
npm run webhook

# Now just tag Jira tickets with "OCR-EXTRACTION" — everything happens automatically!
```

#### Mode 2: CLI (Manual trigger)

```bash
# Process a specific ticket with a local file
node trigger.js OCR-42 ./sample_invoice.pdf

# Process + auto-close the ticket
node trigger.js OCR-42 ./sample_invoice.pdf --close

# Dry run — parse + summarise only, no writes
node trigger.js OCR-42 ./sample_invoice.pdf --dry-run
```

#### Mode 3: Standalone Agent (No Flowise needed)

```bash
# Single ticket
node ocr-agent.js OCR-42 ./sample_invoice.pdf --close

# Auto-poll: find ALL OCR-EXTRACTION tickets and process them
node ocr-agent.js --poll --close

# Poll dry run
node ocr-agent.js --poll --dry-run
```

### npm Scripts Cheatsheet

| Command | What it does |
|---------|-------------|
| `npm run webhook` | Start webhook server (port 3001) |
| `npm run trigger` | CLI trigger (same as `node trigger.js`) |
| `npm run agent` | Standalone agent (same as `node ocr-agent.js`) |
| `npm run poll` | Batch process all pending tickets + auto-close |
| `npm run setup` | Register Jira webhook |

---

## Part 6 — End-to-End Test

Follow these steps to verify everything works:

### 6.1 — Prepare

- [ ] Flowise running at `http://localhost:3000` with the flow imported
- [ ] `.env` fully configured
- [ ] (Webhook mode) ngrok + webhook server running

### 6.2 — Create a test ticket

1. Go to your **OCR** Jira project
2. Create a new ticket:
   - **Summary**: `Test invoice scan`
   - **Attachments**: Upload any PDF or image (invoice, receipt, form)
3. Add the label: `OCR-EXTRACTION`
4. **Save**

### 6.3 — Trigger

**If using webhook mode**: The webhook fires automatically when you add the label. Watch the webhook server terminal for output.

**If using CLI mode**:
```bash
node trigger.js OCR-1 ./sample_invoice.pdf --close
```

### 6.4 — Verify

- [ ] **Jira ticket**: Has a new comment with structured OCR result (heading: 🤖 OCR Automation Result)
- [ ] **Confluence**: A new page exists in the OCR space titled `OCR: OCR-1 — filename.pdf`
- [ ] **Ticket status**: If `--close` was used, ticket should be in "Done" status

### Expected Jira Comment Format

```
TICKET: OCR-1
FILE: sample_invoice.pdf
OCR STATUS: Complete
SUMMARY:
• Invoice #INV-2024-0891 from Acme Corp dated 15 Jan 2024
• Total amount: $4,250.00 (USD) due 14 Feb 2024
• Line items: Software licence × 1, Support plan × 12 months
KEY ENTITIES: Acme Corp, INV-2024-0891, 15 Jan 2024, $4,250.00, Net-30
```

---

## Supported File Types

| Extension | OCR Method (priority order) |
|-----------|---------------------------|
| `.pdf` | Unstructured.io (hi_res) → pdf-parse fallback |
| `.png`, `.jpg`, `.jpeg` | Unstructured.io → OpenAI Vision fallback |
| `.tiff`, `.bmp`, `.webp` | Unstructured.io → OpenAI Vision fallback |

---

## Error Handling

| Error | What Happens |
|-------|-------------|
| OCR returns empty text | `❌ OCR Failed` comment posted, ticket stays open |
| Flowise not reachable | Automatic fallback to OpenAI API directly |
| Wrong transition ID | Auto-discovers correct ID from available transitions |
| Confluence page already exists | Updates existing page (version bump) |
| Duplicate webhook event | Deduplication prevents double-processing |
| Invalid webhook signature | Returns 401 Unauthorized |
| Missing API keys | Clear error message listing which keys are missing |

---

## Project Structure

```
ocr-automation/
├── flowise-flow.json    # Agentic flow — Tool Agent + Jira + OCR + Confluence
├── webhook-server.js     # Express webhook listener (port 3001)
├── setup-webhook.js      # Register Jira webhook via API or manual guide
├── trigger.js           # CLI runner with --webhook, --close, --dry-run
├── ocr-agent.js         # Standalone runner with --poll, --close
├── .env.example         # All required environment variables
├── package.json         # Dependencies + npm scripts
├── .gitignore           # Excludes .env, node_modules
└── README.md            # This file
```

---

## Flowise Agentic Flow — Node Overview

| Node | Type | Purpose |
|------|------|---------|
| **Tool Agent** | `toolAgent` v2 | Autonomous orchestration via GPT-4o function calling |
| **ChatOpenAI** | GPT-4o | Language model (temp 0.2) |
| **Buffer Memory** | `bufferMemory` | Session context |
| **Jira (Issues)** | `jiraTool` | getIssue, listIssues, transitionIssue, updateIssue |
| **Jira (Comments)** | `jiraTool` | createComment, listComments |
| **Custom Tool (OCR)** | `customTool` | Downloads attachment → Unstructured.io / pdf-parse |
| **Confluence POST** | `requestsPost` | Creates page in OCR space |

---

## Cost Estimate

| Service | Cost per document | Monthly (100 docs) |
|---------|------------------|-------------------|
| OpenAI GPT-4o | ~$0.01 - $0.05 | ~$1 - $5 |
| Unstructured.io | Free (1000 pg/mo) | Free |
| Jira Cloud | Free (≤10 users) | Free |
| Confluence Cloud | Free (≤10 users) | Free |
| **Total** | | **~$1 - $5/mo** |

---

## Troubleshooting

### `FLOWISE_CHATFLOW_ID not set`
→ Import `flowise-flow.json` into Flowise UI. Copy the UUID from the browser URL bar: `http://localhost:3000/chatflows/<THIS_UUID>`.

### `Transition ID invalid`
→ The system auto-discovers the right one. Check logs for `Tip: Set JIRA_DONE_TRANSITION_ID=XX`. Or run:
```bash
curl -u email:token https://yourco.atlassian.net/rest/api/3/issue/OCR-1/transitions
```

### `401 Unauthorized` from Jira/Confluence
→ Your API token may have expired. Regenerate at [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens).

### Webhook not firing
1. Check ngrok is running: `ngrok http 3001`
2. Check webhook URL in Jira admin matches the ngrok URL
3. Check the webhook server is running: `npm run webhook`
4. Check the Jira webhook filter: should be `project = OCR`
5. Try POSTing manually: `curl -X POST http://localhost:3001/health`

### Flowise Custom Tool errors
→ Make sure you created the tool in Flowise UI (Tools → Add New) AND set up Variables (ATLASSIAN_EMAIL, ATLASSIAN_TOKEN, UNSTRUCTURED_API_KEY).

### `pdf-parse` errors
→ The PDF may be password-protected or corrupted. Try opening it locally first.

### Confluence `403 Forbidden`
→ Your Atlassian account needs Create Page permissions in the OCR space. Check Space settings → Permissions.

---

## License

MIT
