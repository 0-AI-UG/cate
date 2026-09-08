// Pinned provider-ingestion seam. Forward reported edits BEFORE T3 truncates
// tool activity details. The daemon persists them, independently of guests.
export function patchT3Changes(source) {
  const marker = '/* cate: agent change ingestion v1 */'
  if (source.includes(marker)) {
    source = source.replaceAll('promise$1(() => cate', 'promise(() => cate')
      .replace('yield* promise(() => cateReportChange(event))', 'cateReportChange(event)')
    return source.slice(0, source.indexOf(marker)).trimEnd() + '\n' + changeHelpers
  }
  const before = 'const processRuntimeEvent = (event) => gen$1(function* () {\n\t\tif (event.type === "content.delta"'
  if (source.split(before).length !== 2) throw new Error('T3 provider change ingestion seam changed')
  source = source.replace(before, 'const processRuntimeEvent = (event) => gen$1(function* () {\n\t\tif (process.env.CATE_CHANGES_ENDPOINT && (event.type === "turn.diff.updated" || event.type === "item.completed")) cateReportChange(event);\n\t\tif (event.type === "content.delta"')
  const start = '\t\tconst files = yield* (fromCheckpointExists ? checkpointStore.diffCheckpoints({'
  const from = source.indexOf(start)
  const to = source.indexOf('\n\t\tconst assistantMessageId = input.assistantMessageId', from)
  if (from < 0 || to < 0 || source.indexOf(start, from + 1) >= 0) throw new Error('T3 checkpoint summary seam changed')
  const original = source.slice(from, to)
  source = source.slice(0, from) + '\t\tconst files = process.env.CATE_CHANGES_ENDPOINT ? yield* promise(() => cateChangeSummary(input.threadId, input.turnId)) : ' + original.slice('\t\tconst files = '.length) + source.slice(to)
  return source.trimEnd() + '\n' + changeHelpers
}

// A bounded independent queue keeps capture outages out of provider ingestion.
// Per-turn chains retain operation order; unrelated turns can progress together.
const changeHelpers = `/* cate: agent change ingestion v1 */
const cateChangesTurns=new Map();
let cateChangesCount=0,cateChangesBytes=0,cateChangesActive=0;
const cateChangesWaiting=[];
async function cateChangesSlot(){
  if(cateChangesActive>=4)await new Promise(resolve=>cateChangesWaiting.push(resolve));
  else cateChangesActive++;
}
function cateChangesRelease(){
  const next=cateChangesWaiting.shift();
  if(next)next();else cateChangesActive--;
}
async function cateChangesRequest(suffix,body){
  const response=await fetch(process.env.CATE_CHANGES_ENDPOINT+'/t3-changes'+suffix,{
    method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env.CATE_CHANGES_TOKEN},
    body:JSON.stringify({terminalId:process.env.CATE_CHANGES_SOURCE,...body}),signal:AbortSignal.timeout(5000)
  });
  if(!response.ok)throw new Error('Agent change capture HTTP '+response.status);
  return response.json();
}
function cateReportChange(event){
  if(event.type==='item.completed'&&(event.payload?.status!=='completed'||['assistant_message','reasoning'].includes(event.payload?.itemType)))return;
  const bytes=JSON.stringify(event).length*2;
  if(cateChangesCount>=256||cateChangesBytes+bytes>16*1024*1024){
    console.warn('[cate changes] Capture queue full; recorded edits may be incomplete.');return;
  }
  const key=JSON.stringify([event.threadId,event.turnId]);
  cateChangesCount++;cateChangesBytes+=bytes;
  const pending=(cateChangesTurns.get(key)??Promise.resolve()).then(async()=>{
    await cateChangesSlot();
    try{
      for(let attempt=0;attempt<3;attempt++){
        try{await cateChangesRequest('',{payload:event});return;}
        catch(error){
          if(attempt===2){console.warn('[cate changes] Capture failed after retries; recorded edits may be incomplete.',error.message);return;}
          await new Promise(resolve=>setTimeout(resolve,250*(attempt+1)));
        }
      }
    }finally{cateChangesRelease();}
  }).finally(()=>{
    cateChangesCount--;cateChangesBytes-=bytes;
    if(cateChangesTurns.get(key)===pending)cateChangesTurns.delete(key);
  });
  cateChangesTurns.set(key,pending);
}
async function cateChangeSummary(threadId,turnId){
  await cateChangesTurns.get(JSON.stringify([threadId,turnId]));
  try{return await cateChangesRequest('/summary',{threadId,turnId});}
  catch(error){console.warn('[cate changes]',error.message);return [];}
}
`
