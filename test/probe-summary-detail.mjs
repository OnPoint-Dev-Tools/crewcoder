import { spawn } from 'node:child_process';
import readline from 'node:readline';

const child = spawn(process.env.CREWCODER_CODEX_PATH ?? 'codex', ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
const pending = new Map();
let id = 0, active, done;
const timer = setTimeout(() => { child.kill(); console.error('probe timed out'); process.exitCode = 1; }, 55000);
const request = (method, params) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, {resolve,reject}); child.stdin.write(JSON.stringify({id:n, method, params})+'\n'); });
readline.createInterface({input: child.stdout}).on('line', line => {
  const m = JSON.parse(line);
  if (m.id !== undefined && !m.method) {
    const p = pending.get(m.id); pending.delete(m.id);
    if (p) m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  }
  if (m.method === 'item/reasoning/summaryTextDelta') active.summary += m.params.delta;
  if (m.method === 'item/reasoning/textDelta') active.raw += m.params.delta;
  if (m.method === 'item/completed' && m.params.item.type === 'reasoning') active.completed.push({summary:m.params.item.summary, content:m.params.item.content});
  if (m.method === 'turn/completed') done(m.params.turn.status);
  if (m.method && m.id !== undefined) child.stdin.write(JSON.stringify({id:m.id,error:{code:-32601,message:'No tools in this probe'}})+'\n');
});
try {
  await request('initialize',{clientInfo:{name:'crewcoder-summary-probe',version:'1'}});
  for (const summary of ['auto','detailed']) {
    const {thread, model} = await request('thread/start',{cwd:process.cwd(),approvalPolicy:'never',sandbox:'read-only',ephemeral:true,model:'gpt-6.1-sol'});
    active = {mode:summary, model, summary:'', raw:'', completed:[]};
    const completion = new Promise(resolve => {done=resolve;});
    await request('turn/start',{threadId:thread.id,summary,effort:'medium',input:[{type:'text',text:'Without using tools, analyze how a client should merge streamed, indexed summary sections and authoritative final snapshots while avoiding duplicates in text-only legacy consumers. Consider out-of-order events and corrected final text. Give three practical design rules.'}]});
    active.status = await completion;
    console.log(JSON.stringify(active));
  }
} finally { clearTimeout(timer); child.kill(); }
