import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { runCodexCliProvider } from '../crewcoder-agent/dist/providers/codex-app-server-provider.js';

const codex = process.env.CREWCODER_VERIFY_CODEX_PATH;
assert(codex, 'Set CREWCODER_VERIFY_CODEX_PATH to the installed Codex executable');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'crewcoder-real-codex-'));
const catalog = JSON.parse(execFileSync(codex, ['debug', 'models', '--bundled'], { encoding: 'utf8' }));
const model = catalog.models.find(m => m.slug === 'gpt-6.1-terra') ?? catalog.models.find(m => m.apply_patch_tool_type);
assert(model, 'need a bundled model with native patching');
const codexHome = path.join(root, 'codex');
await fs.mkdir(codexHome);
const catalogPath = path.join(root, 'models.json');
await fs.writeFile(catalogPath, JSON.stringify({ models: [model] }));
await fs.writeFile(path.join(root, 'sample.txt'), 'before');
let requests = 0;
const bodies = [];
const mcpRequests = [];
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (req.url !== '/v1/responses') {
    mcpRequests.push({ path: req.url, method: body ? JSON.parse(body).method : null, duringTurn: requests % 2 === 1 });
    res.writeHead(503); res.end(); return;
  }
  bodies.push(JSON.parse(body));
  requests++;
  const item = requests % 2 === 1
    ? { type: 'custom_tool_call', id: 'exec-1', call_id: 'call-1', name: 'exec', input: 'text({offeredTools:ALL_TOOLS.map(t=>t.name)});text(await tools.edit({path:"sample.txt",find:"before",replace:"after"}));' }
    : { type: 'message', id: 'msg-1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] };
  res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
  for (const event of [
    { type: 'response.created', response: { id: `r-${requests}`, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: `r-${requests}`, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } },
  ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await fs.writeFile(path.join(codexHome, 'config.toml'), `model_provider = "fixture"\nmodel_catalog_json = ${JSON.stringify(catalogPath)}\n[model_providers.fixture]\nname = "Local tool verification"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
const marker = path.join(root, 'unexpected-mcp-start');
await fs.appendFile(path.join(codexHome, 'config.toml'), `
[mcp_servers.http_docs]
url = "http://127.0.0.1:${port}/mcp"
enabled = true
[mcp_servers.local_stdio]
command = ${JSON.stringify(process.execPath)}
args = ${JSON.stringify(["-e", "require('node:fs').writeFileSync(" + JSON.stringify(marker) + ",'started')"])}
enabled = true
`);
process.env.CODEX_HOME = codexHome;
process.env.CREWCODER_HOME = path.join(root, 'crewcoder');
process.env.CREWCODER_CODEX_PATH = codex;
const executed = [];
let providerSessionId;
const resumedIds = [];
for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_APP_SERVER_WS_URL']) delete process.env[key];
try {
  const run = async continuation => runCodexCliProvider({
    provider: { id: 'codex-cli', title: 'Codex', kind: 'builtin', runtime: 'openai-codex-responses', command: 'codex', args: [] },
    cwd: root, model: model.slug, prompt: 'edit sample.txt',
    modelInput: { systemPrompt: 'Use supplied editing tools.', messages: [{ role: 'user', content: [{ type: 'text', text: 'edit sample.txt' }] }],
      session: { sessionId: 'local-verification', continuation, ...(providerSessionId ? { providerSessionId } : {}) },
      toolMode: 'crewcoder', approvalMode: 'full-access', availableTools: [{ name: 'edit', description: 'Edit file', parameters: { type: 'object', properties: { path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' } }, required: ['path', 'find', 'replace'] } }] },
    stream: { onProviderSessionId: async id => { providerSessionId = id; resumedIds.push(id); }, executeTool: async call => {
      executed.push(call.name);
      assert.equal(call.name, 'edit');
      assert.equal(call.arguments.path, 'sample.txt');
      await fs.writeFile(path.join(root, 'sample.txt'), 'after');
      return { role: 'toolResult', toolName: call.name, toolCallId: call.id, content: [{ type: 'text', text: 'edited' }], isError: false, timestamp: Date.now() };
    } },
  }, AbortSignal.timeout(25000));
  const first = await run(false);
  assert.equal(first.exitCode, 0, JSON.stringify(first));
  assert(providerSessionId);
  await fs.writeFile(path.join(root, 'sample.txt'), 'before');
  const result = await run(true);
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(resumedIds[0], resumedIds[1]);
  assert.deepEqual(executed, ['edit', 'edit']);
  assert.equal(await fs.readFile(path.join(root, 'sample.txt'), 'utf8'), 'after');
  const offered = [];
  for (const body of [bodies[1], bodies[3]]) {
    const output = body.input.find(item => item.type === 'custom_tool_call_output' && JSON.stringify(item.output).includes('offeredTools'));
    assert(output, 'missing code mode tool output');
    const reading = output.output.find(item => item.type === 'input_text' && item.text.includes('offeredTools'));
    const names = JSON.parse(reading.text).offeredTools;
    assert(names.includes('edit'));
    assert(!names.includes('apply_patch'));
    offered.push(names);
  }
  // mcp list can probe HTTP authentication before lockdown; no native turn may call it.
  assert(mcpRequests.every(request => !request.duringTurn && request.method !== 'tools/call'));
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
  console.log(JSON.stringify({ root, requests, executed, model: model.slug, result: result.stdout, offered, resumedSameThread: resumedIds[0] === resumedIds[1], httpMcpAuthProbes: mcpRequests.length, stdioMcpStarted: false }, null, 2));
} finally {
  await fs.writeFile(path.join(root, 'requests.json'), JSON.stringify(bodies, null, 2));
  server.closeAllConnections();
  server.close();
}
