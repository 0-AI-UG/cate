// Pinned provider-ingestion seam. Forward reported edits BEFORE T3 truncates
// tool activity details. The daemon persists them, independently of guests.
export function patchT3Changes(source) {
  const marker = '/* cate: agent change ingestion v1 */'
  if (source.includes(marker)) return source.replaceAll('promise$1(() => cate', 'promise(() => cate')
  const before = 'const processRuntimeEvent = (event) => gen(function* () {\n\t\tif (event.type === "content.delta"'
  if (source.split(before).length !== 2) throw new Error('T3 provider change ingestion seam changed')
  source = source.replace(before, 'const processRuntimeEvent = (event) => gen(function* () {\n\t\tif (process.env.CATE_CHANGES_ENDPOINT && (event.type === "turn.diff.updated" || event.type === "item.completed")) yield* promise(() => cateReportChange(event));\n\t\tif (event.type === "content.delta"')
  const start = '\t\tconst files = yield* checkpointStore.diffCheckpoints({'
  const from = source.indexOf(start)
  const to = source.indexOf('\n\t\tconst assistantMessageId = input.assistantMessageId', from)
  if (from < 0 || to < 0 || source.indexOf(start, from + 1) >= 0) throw new Error('T3 checkpoint summary seam changed')
  const original = source.slice(from, to)
  source = source.slice(0, from) + '\t\tconst files = process.env.CATE_CHANGES_ENDPOINT ? yield* promise(() => cateChangeSummary(input.threadId, input.turnId)) : ' + original.slice('\t\tconst files = '.length) + source.slice(to)
  return source + `\n${marker}
let cateChangesPending=Promise.resolve();
async function cateChangesRequest(suffix,body){
  const response=await fetch(process.env.CATE_CHANGES_ENDPOINT+'/t3-changes'+suffix,{
    method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env.CATE_CHANGES_TOKEN},
    body:JSON.stringify({terminalId:process.env.CATE_CHANGES_SOURCE,...body}),signal:AbortSignal.timeout(5000)
  });
  if(!response.ok)throw new Error('Agent change capture HTTP '+response.status);
  return response.json();
}
function cateReportChange(event){
  cateChangesPending=cateChangesPending.catch(()=>{}).then(()=>cateChangesRequest('',{payload:event}));
  return cateChangesPending.catch(error=>{console.warn('[cate changes]',error.message);});
}
async function cateChangeSummary(threadId,turnId){
  await cateChangesPending.catch(()=>{});
  try{return await cateChangesRequest('/summary',{threadId,turnId});}
  catch(error){console.warn('[cate changes]',error.message);return [];}
}
`
}
