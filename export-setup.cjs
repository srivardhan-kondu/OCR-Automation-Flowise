const Database = require('/Users/srivardhan/.nvm/versions/node/v20.20.2/lib/node_modules/flowise/node_modules/better-sqlite3');
const fs = require('fs');
const path = require('path');

const db = new Database('/Users/srivardhan/.flowise/database.sqlite', { readonly: true });
const projectDir = '/Users/srivardhan/Flowise/ocr-automation';

try {
    // 1. Export the Chatflow
    const flowId = '00a20a67-ddd0-45f6-a8bb-e53a2efcb4d7';
    const flowRecord = db.prepare('SELECT flowData FROM chat_flow WHERE id = ?').get(flowId);
    
    if (flowRecord) {
        fs.writeFileSync(path.join(projectDir, 'flowise-flow.json'), flowRecord.flowData);
        console.log('✓ Updated flowise-flow.json');
    }

    // 2. Export All Tools
    const tools = db.prepare('SELECT * FROM tool').all();
    const toolsDir = path.join(projectDir, 'tools');
    if (!fs.existsSync(toolsDir)) fs.mkdirSync(toolsDir, { recursive: true });

    const targetTools = ['jira_fetch_issue', 'ocr_extract_text', 'jira_post_and_close', 'confluence_create_page'];
    
    tools.forEach(tool => {
        if (targetTools.includes(tool.name)) {
            // Clean up internal database IDs before exporting so they are "Generic" for others
            const toolExport = { ...tool };
            // Optional: You could strip createdDate/updatedDate as well, but this is fine.
            fs.writeFileSync(path.join(toolsDir, `${tool.name}.json`), JSON.stringify(toolExport, null, 2));
            console.log(`✓ Saved tool: tools/${tool.name}.json`);
        }
    });

} catch (err) {
    console.error('Export failed:', err.message);
}
