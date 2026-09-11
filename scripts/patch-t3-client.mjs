import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// Deliberately pinned to t3@0.0.39. Fail at install/build time when upstream
// changes these seams, rather than silently shipping a partially embedded app.
export function patchT3ClientSource(source) {
  const marker = '/* cate: chat host bridge v1 */'
  const finish = (value) => {
    const before = 'window.__cateHost.request("open-agent",{placementId:catePlacement,threadId:c,title:d})'
    const after = before + '.catch(()=>{K.add(Ia({type:"error",title:"Conversation started",description:"Open the new conversation from Cate’s conversation picker."}))})'
    if (value.includes(after)) return patchT3PromptContext(patchT3ChangeSummaries(value))
    if (value.split(before).length !== 2) throw new Error('T3 implementation handoff changed')
    return patchT3PromptContext(patchT3ChangeSummaries(value.replace(before, after)))
  }
  if (source.includes(marker)) return finish(source)
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error(`T3 chat bridge changed: ${before.slice(0,80)}`)
    source = source.replace(before, after)
  }
  replace('if(!q)return(0,Q.jsx)(Ew,{});let vm=',
    'window.__cateChat={store:ti,threadRef:J,openAgents:ud,closeAgents:()=>J&&ti.getState().close(J)};if(!q)return(0,Q.jsx)(Ew,{});let vm=')
  replace('let r=Uo(e,wl,{context:n});if(!r)return;',
    'let r=Uo(e,wl,{context:n});if(!r)return;if(window.__cateHost&&window.__cateHost.shortcut(r)){e.preventDefault();e.stopPropagation();return;}')
  replace('!qr||!J||(pd.getState().selectTurn(J,e,t),ti.getState().open(J,`diff`),a?.())',
    'window.__cateHost?window.__cateHost.request("diff",{threadId:J?.threadId,turnId:e,filePath:t}):(!qr||!J||(pd.getState().selectTurn(J,e,t),ti.getState().open(J,`diff`),a?.()))')
  // Ask for placement after provider validation, before creating/sending anything.
  replace('let d=ip(Cp(l)),f=o;or.current=!0,Ec({preparingWorktree:!1});',
    'let d=ip(Cp(l)),f=o;or.current=!0;let catePlacement;try{catePlacement=window.__cateHost?await window.__cateHost.request("place-agent",{}):true;}catch{or.current=!1;return;}if(!catePlacement){or.current=!1;return;}Ec({preparingWorktree:!1});')
  replace('()=>we({to:`/$environmentId/$threadId`,params:{environmentId:q.environmentId,threadId:c}})',
    '()=>window.__cateHost?window.__cateHost.request("open-agent",{placementId:catePlacement,threadId:c,title:d}):we({to:`/$environmentId/$threadId`,params:{environmentId:q.environmentId,threadId:c}})')
  return finish(marker + source)
}

/** Add relation context after the visible draft has been captured for send.
 * T3 is embedded, so this uses its host bridge rather than a CLI hook. */
export function patchT3PromptContext(source) {
  const marker = '/* cate: submit-time panel prompt context v3 */'
  const oldRequest = 'window.__cateHost.request("relation-context",{})'
  const providerRequest = 'window.__cateHost.request("relation-context",{provider:v})'
  if (source.includes(marker)) return source.includes(oldRequest)
    ? source.replace(oldRequest, providerRequest)
    : source
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error(`T3 panel prompt seam changed: ${before.slice(0, 80)}`)
    source = source.replace(before, after)
  }

  const prompt = 'fe=sT({provider:v,model:b,models:S,effort:C,text:qe(de,ce)||`[User attached one or more files without additional text. Respond using the conversation context and the attached files.]`});if(ft.current?.validateProviderInput(fe)===!1)return;'
  const submitPrompt = prompt.replace(
    ';if(ft.current?.validateProviderInput(fe)===!1)return;',
    ';let catePrompt=fe;if(window.__cateHost)try{let cateContext=await window.__cateHost.request("relation-context",{provider:v});if(cateContext)catePrompt=fe+`\\n\\n`+cateContext}catch{}if(ft.current?.validateProviderInput(catePrompt)===!1)return;',
  )
  const oldAugmentedPrompt = prompt.replace(
    ';if(ft.current?.validateProviderInput(fe)===!1)return;',
    ';let catePrompt=fe;if(window.__cateHost)try{catePrompt=await window.__cateHost.request("augment-prompt",{text:fe})}catch{}if(ft.current?.validateProviderInput(catePrompt)===!1)return;',
  )
  if (source.includes(oldAugmentedPrompt)) source = source.replace(oldAugmentedPrompt, submitPrompt)
  else replace(prompt, submitPrompt)
  if (source.includes('text:fe,attachments:Ee.value')) {
    replace('text:fe,attachments:Ee.value', 'text:catePrompt,attachments:Ee.value')
  }

  const baseChat = 'window.__cateChat={store:ti,threadRef:J,openAgents:ud,closeAgents:()=>J&&ti.getState().close(J)};'
  const v1Chat = 'window.__cateChat={store:ti,threadRef:J,openAgents:ud,closeAgents:()=>J&&ti.getState().close(J),sendText:async e=>(await sm({text:e,interactionMode:`default`}),true)};'
  const v2Chat = 'window.__cateChat={store:ti,threadRef:J,openAgents:ud,closeAgents:()=>J&&ti.getState().close(J),sendText:async e=>(await sm({text:e,interactionMode:`default`}),true),appendText:e=>{let t=it.current?it.current+`\\n\\n`+e:e;it.current=t,Ie(ue,t);return!0}};'
  if (source.includes(v2Chat)) source = source.replace(v2Chat, v1Chat)
  else if (source.includes(baseChat)) replace(baseChat, v1Chat)
  return source + '\n' + marker
}

export function patchT3ChangeSummaries(source) {
  const marker = '/* cate: recorded change summaries v1 */'
  if (source.includes(marker)) return patchT3TurnSummaryFallback(source)
  const before = 'onOpenTurnDiff:a}=e;if(!n)return null;let o=n.files;if(o.length===0)return null;'
  if (source.split(before).length !== 2) throw new Error('T3 changed-file summary seam changed')
  const after = 'onOpenTurnDiff:a}=e;let cateFiles=cateUseTurnFiles(n?.turnId);if(!n)return null;let o=window.__cateHost?cateFiles:n.files;if(o.length===0)return window.__cateHost?(0,Q.jsx)(`button`,{type:`button`,className:`mt-2 text-xs text-muted-foreground`,onClick:()=>a(n.turnId),children:`No recorded edits · tracking may be incomplete`}):null;'
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
    ['t[23]!==n.assistantTurnDiffSummary?', 't[23]!==n?'],
    ['t[23]=n.assistantTurnDiffSummary,t[24]=g', 't[23]=n,t[24]=g'],
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
  const before = 't[4]=n,t[5]=s):s=t[5],s});function US'
  const after = 't[4]=n,t[5]=s):s=t[5],window.__cateHost?(0,Q.jsxs)(`div`,{children:[s,(0,Q.jsx)(`p`,{className:`mt-1 text-[10px] text-muted-foreground`,children:`Recorded edits; unreported changes may be missing.`})]}):s});function US'
  if (source.split(before).length !== 2) throw new Error('T3 recorded edit coverage seam changed')
  return source.replace(before, after) + '\n' + marker
}

export function patchT3Client(directory) {
  const entries = readdirSync(directory).filter((name) => /^ChatView-.*\.js$/.test(name))
  if (entries.length !== 1) throw new Error('T3 client entry changed')
  const file = path.join(directory, entries[0])
  const source = readFileSync(file, 'utf8')
  const patched = patchT3ClientSource(source)
  if (patched !== source) writeFileSync(file, patched)
}
