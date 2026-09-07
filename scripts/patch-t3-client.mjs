import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// Deliberately pinned to t3@0.0.38. Fail at install/build time when upstream
// changes these seams, rather than silently shipping a partially embedded app.
export function patchT3ClientSource(source) {
  const marker = '/* cate: chat host bridge v1 */'
  const finish = (value) => {
    const before = 'window.__cateHost.request("open-agent",{placementId:catePlacement,threadId:c,title:d})'
    const after = before + '.catch(()=>{vT.add(_T({type:"error",title:"Conversation started",description:"Open the new conversation from Cate’s conversation picker."}))})'
    if (value.includes(after)) return patchT3ChangeSummaries(value)
    if (value.split(before).length !== 2) throw new Error('T3 implementation handoff changed')
    return patchT3ChangeSummaries(value.replace(before, after))
  }
  if (source.includes(marker)) return finish(source)
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error(`T3 chat bridge changed: ${before.slice(0,80)}`)
    source = source.replace(before, after)
  }
  replace('if(!Ln)return(0,Z.jsx)(Hzt,{});let Hl=',
    'window.__cateChat={store:As,threadRef:nr,openAgents:ns,closeAgents:us};if(!Ln)return(0,Z.jsx)(Hzt,{});let Hl=')
  replace('let r=ib(e,to,{context:n});if(!r)return;',
    'let r=ib(e,to,{context:n});if(!r)return;if(window.__cateHost&&window.__cateHost.shortcut(r)){e.preventDefault();e.stopPropagation();return;}')
  replace('!In||!nr||(Akt.getState().selectTurn(nr,e,t),As.getState().open(nr,`diff`),i?.())',
    'window.__cateHost?window.__cateHost.request("diff",{threadId:nr?.threadId,turnId:e,filePath:t}):(!In||!nr||(Akt.getState().selectTurn(nr,e,t),As.getState().open(nr,`diff`),i?.()))')
  // Ask for placement after provider validation, before creating/sending anything.
  replace('let d=Ekt(Zkt(l)),f=o;fn.current=!0,ha({preparingWorktree:!1});',
    'let d=Ekt(Zkt(l)),f=o;fn.current=!0;let catePlacement;try{catePlacement=window.__cateHost?await window.__cateHost.request("place-agent",{}):true;}catch{fn.current=!1;return;}if(!catePlacement){fn.current=!1;return;}ha({preparingWorktree:!1});')
  replace('()=>pe({to:`/$environmentId/$threadId`,params:{environmentId:Ln.environmentId,threadId:c}})',
    '()=>window.__cateHost?window.__cateHost.request("open-agent",{placementId:catePlacement,threadId:c,title:d}):pe({to:`/$environmentId/$threadId`,params:{environmentId:Ln.environmentId,threadId:c}})')
  return finish(marker + source)
}

export function patchT3ChangeSummaries(source) {
  const marker = '/* cate: recorded change summaries v1 */'
  if (source.includes(marker)) return patchT3TurnSummaryFallback(source)
  const before = 'onOpenTurnDiff:a}=e;if(!n)return null;let o=n.files;if(o.length===0)return null;'
  if (source.split(before).length !== 2) throw new Error('T3 changed-file summary seam changed')
  const after = 'onOpenTurnDiff:a}=e;let cateFiles=cateUseTurnFiles(n?.turnId);if(!n)return null;let o=window.__cateHost?cateFiles:n.files;if(o.length===0)return window.__cateHost?(0,Z.jsx)(`button`,{type:`button`,className:`mt-2 text-xs text-muted-foreground`,onClick:()=>a(n.turnId),children:`No recorded edits · tracking may be incomplete`}):null;'
  return patchT3TurnSummaryFallback(source.replace(before, after) + `\n${marker}
const cateEmptyFiles=[];
function cateSubscribeChanges(listener){window.addEventListener('cate-changes',listener);return()=>window.removeEventListener('cate-changes',listener);}
function cateUseTurnFiles(turnId){return (0,X.useSyncExternalStore)(cateSubscribeChanges,()=>window.__cateChanges?.turns?.[turnId]??cateEmptyFiles);}
`)
}

function patchT3TurnSummaryFallback(source) {
  const marker = '/* cate: checkpoint-independent summaries */'
  if (source.includes(marker)) return patchT3CoverageLabel(source)
  const edits = [
    ['t[14]!==n.assistantTurnDiffSummary?', 't[14]!==n?'],
    ['t[14]=n.assistantTurnDiffSummary,t[15]=u', 't[14]=n,t[15]=u'],
    ['turnSummary:n.assistantTurnDiffSummary,routeThreadKey:', 'turnSummary:n.assistantTurnDiffSummary??(n.showAssistantMeta&&!n.message.streaming&&n.message.turnId?{turnId:n.message.turnId,files:[]}:undefined),routeThreadKey:'],
  ]
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2) throw new Error('T3 assistant turn summary fallback seam changed')
    source = source.replace(before, after)
  }
  return patchT3CoverageLabel(source + '\n' + marker)
}

function patchT3CoverageLabel(source) {
  const marker = '/* cate: recorded edit coverage */'
  if (source.includes(marker)) return source
  const before = 't[4]=n,t[5]=s):s=t[5],s});function HLt'
  const after = 't[4]=n,t[5]=s):s=t[5],window.__cateHost?(0,Z.jsxs)(`div`,{children:[s,(0,Z.jsx)(`p`,{className:`mt-1 text-[10px] text-muted-foreground`,children:`Recorded edits; unreported changes may be missing.`})]}):s});function HLt'
  if (source.split(before).length !== 2) throw new Error('T3 recorded edit coverage seam changed')
  return source.replace(before, after) + '\n' + marker
}

export function patchT3Client(directory) {
  const entries = readdirSync(directory).filter((name) => /^index-.*\.js$/.test(name))
  if (entries.length !== 1) throw new Error('T3 client entry changed')
  const file = path.join(directory, entries[0])
  const source = readFileSync(file, 'utf8')
  const patched = patchT3ClientSource(source)
  if (patched !== source) writeFileSync(file, patched)
}
