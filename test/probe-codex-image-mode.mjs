// Real local Codex app-server against a scripted loopback endpoint, never OpenAI.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { codexToolResult } from '../crewcoder-agent/dist/providers/codex-tool-images.js'
import { readTool } from '../crewcoder-agent/dist/tools/read.js'

const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-image-mode-'))
const mode=process.argv[2] ?? 'text'
fs.writeFileSync(path.join(root,'screen.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC','base64'))
const requests=[]
let child
const server=http.createServer(async(req,res)=>{
 let raw=''
 for await (const chunk of req) raw+=chunk
 let body
 try {body=JSON.parse(raw)} catch {res.writeHead(404);res.end();return}
 requests.push(body)
 fs.writeFileSync(path.join(root,'request-'+requests.length+'.json'),JSON.stringify(body,null,2))
 const send=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n')
 res.writeHead(200,{'content-type':'text/event-stream','connection':'close'})
 const id='resp_'+requests.length
 send('response.created',{response:{id,object:'response',status:'in_progress',output:[]}})
 let item
 if(requests.length===1) {
  console.log('TOOLS:'+JSON.stringify(body.input?.filter(i=>i.type==='additional_tools').flatMap(i=>i.tools).map(t=>({name:t.name,type:t.type,tools:t.tools?.map(x=>({name:x.name,type:x.type}))}))))
  const tool=body.tools?.find(t=>t.name==='exec' || t.name==='code_mode')
    ?? body.tools?.flatMap(t=>t.tools ?? []).find(t=>t.name==='exec')
  const name=tool?.name ?? 'exec'
  const code=mode==='extract' ? 'const result=await tools.read({path:"screen.png"}); for (const line of result.split("\\n")) { if (line.startsWith("data:image/")) image(line); }' : mode==='image' ? 'const r=await tools.read({path:"screen.png"}); image(r);' : 'const r=await tools.read({path:"screen.png"}); text(r);'
  item={type:'custom_tool_call',id:'fc_image',call_id:'call_image',name,namespace:'functions',input:code}
 } else item={type:'message',id:'message_done',role:'assistant',content:[{type:'output_text',text:'probe complete',annotations:[]}]}
 send('response.output_item.added',{output_index:0,item})
 send('response.output_item.done',{output_index:0,item})
 send('response.completed',{response:{id,object:'response',status:'completed',output:[item],usage:{input_tokens:10,output_tokens:10,total_tokens:20}}})
 res.end()
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const port=server.address().port
const args=[
 '-c','model_provider="fixture"','-c','model_providers.fixture.name="Fixture"',
 '-c','model_providers.fixture.wire_api="responses"','-c','model_providers.fixture.requires_openai_auth=false',
 '-c','model_providers.fixture.base_url="http://127.0.0.1:'+port+'"',
 '--disable','shell_tool','--disable','unified_exec','--disable','view_image',
 '-c','web_search="disabled"','app-server','--stdio'
]
const env={...process.env,CODEX_HOME:path.join(root,'.codex')}
for(const key of ['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL']) delete env[key]
fs.mkdirSync(env.CODEX_HOME,{recursive:true})
child=spawn(process.env.PROBE_CODEX_PATH ?? 'C:\\Users\\family\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe',args,{cwd:root,env,stdio:['pipe','pipe','pipe'],windowsHide:true})
let stderr=''
child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000)})
const pending=new Map()
let sequence=0
const send=(method,params)=>new Promise((resolve,reject)=>{
 const id=++sequence;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,params})+'\n')
})
let complete
const completed=new Promise(resolve=>{complete=resolve})
readline.createInterface({input:child.stdout}).on('line',async line=>{
 let m;try{m=JSON.parse(line)}catch{return}
 if(m.id && pending.has(m.id)) {
  const p=pending.get(m.id);pending.delete(m.id)
  if(m.error)p.reject(new Error(JSON.stringify(m.error)));else p.resolve(m.result)
 } else if(m.method==='item/tool/call') {
  const call=m.params
  const result={role:'toolResult',toolCallId:call.callId,toolName:call.tool,timestamp:0,isError:false,
   ...await readTool.execute(readTool.parse(call.arguments),{cwd:root,mode:'general',sessionId:'probe',mutationLog:[]})}
  const wire=await codexToolResult(result,root)
  console.log('DYNAMIC_REPLY:'+JSON.stringify({contentTypes:wire.contentItems.map(i=>i.type),success:wire.success}))
  child.stdin.write(JSON.stringify({id:m.id,result:wire})+'\n')
 } else if(m.method==='turn/completed') complete(m.params)
 else if(m.method==='item/completed' && m.params?.item?.type!=='agentMessage') console.log('ITEM:'+JSON.stringify(m.params.item))
})
child.once('exit',()=>{for(const p of pending.values())p.reject(new Error('Codex exited: '+stderr));pending.clear();complete({exited:true,stderr})})
const timer=setTimeout(()=>{console.error('probe timeout '+stderr);for(const p of pending.values())p.reject(new Error('probe timeout'));pending.clear();child.kill();complete({timeout:true})},35000)
try{
 await send('initialize',{clientInfo:{name:'image-probe',title:'image-probe',version:'1'},capabilities:{experimentalApi:true}})
 child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n')
 const thread=await send('thread/start',{model:'gpt-5.6-luna',cwd:root,approvalPolicy:'never',sandbox:'read-only',
  dynamicTools:[{type:'function',name:'read',description:readTool.description,inputSchema:readTool.parameters}]})
 await send('turn/start',{threadId:thread.thread.id,model:'gpt-5.6-luna',input:[{type:'text',text:'Run the read tool on screen.png and inspect it.',text_elements:[]}],
  approvalPolicy:'never',sandboxPolicy:{type:'readOnly'}})
 console.log('COMPLETED:'+JSON.stringify(await completed))
 for(let i=1;i<requests.length;i++){
  const input=requests[i].input
  console.log('FOLLOWUP_INPUT:'+JSON.stringify(input?.filter(i=>i.type.includes('call_output') || i.role==='tool' || i.content?.some(c=>c.type==='input_image'))))
 }
 console.log('Probe files: '+root)
} finally {clearTimeout(timer);child.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
