const CSS = {
  typography: `
    article:nth-child(3n) { font: 600 18px system-ui; padding:3px 5px; }
    article:nth-child(4n) { font: italic 15px Georgia; word-spacing:3px; }
    article:nth-child(7n) code { transform:translate(.3px,.1px); }
    article:nth-child(5n) { font: 13px monospace; }
  `,
  vector: `
    svg { width:31px;height:31px;vertical-align:middle; }
    article:nth-child(2n) svg { transform:rotate(21deg) scale(.82); }
    article:nth-child(3n) svg { opacity:.73; }
    article:nth-child(5n) svg { color:#05ba94; }
  `,
  'filter-only': `
    article:nth-child(3n) { filter:drop-shadow(2px 1px 2px #8debff) saturate(.8); }
  `,
  'backdrop-only': `
    main { background:linear-gradient(125deg,#0e2c57,#744727); }
    article:nth-child(5n) { background:#a2f8; backdrop-filter:blur(6px); mix-blend-mode:screen; }
  `,
  'mask-only': `
    article { border-radius:7px; }
    article:nth-child(2n) { clip-path:inset(2px 1px 1px round 4px 10px); }
    article:nth-child(7n) { mask-image:linear-gradient(to left,#000,transparent); }
  `,
  effects: `
    main { background:linear-gradient(125deg,#0e2c57,#744727); }
    article { border-radius:7px; background:linear-gradient(20deg,#7661a4a8,transparent),#a2f8; box-shadow:inset 1px 2px 3px #fff3,0 3px 6px #1321; }
    article:nth-child(2n) { clip-path:inset(2px 1px 1px round 4px 10px); }
    article:nth-child(3n) { filter:drop-shadow(2px 1px 2px #8debff) saturate(.8); }
    article:nth-child(4n) { background:radial-gradient(ellipse at 50% 10%,#ffc7,transparent 75%); }
    article:nth-child(5n) { backdrop-filter:blur(6px); mix-blend-mode:screen; }
    article:nth-child(7n) { mask-image:linear-gradient(to left,#000,transparent); }
  `,
}
const phrases = ['Build report','Review summary','Glyphs ěλ号','New branch','Snow ❄','خط عربي','Elapsed 1.43 ms']
const icon = index => {
  const number = index % 5
  const fill = `url(#gradient-${index})`
  const geometry = [
    `<path fill="${fill}" fill-rule="evenodd" d="M2 1h26v26H2zM8 8v11h11V8z"/><path stroke="#402867" d="M5 25l11-17 8 16"/>`,
    `<path stroke="currentColor" stroke-width="2" fill="none" d="M4 22Q8 2 15 12T28 5"/><circle cx="13" cy="16" r="6" fill="${fill}"/>`,
    `<path fill="${fill}" d="M3 17c5-12 12-13 20-8s4 13-2 16S2 21 3 17z"/><circle cx="14" cy="14" r="4" fill="#0007"/>`,
    `<path stroke="${fill}" stroke-width="3" stroke-linecap="round" fill="none" d="M6 6h18M8 14h6m2 1 10 12"/>`,
    `<path fill="${fill}" d="M1 28l9-24 5 9 7-11 7 26z"/>`,
  ][number]
  return `<svg viewBox="0 0 30 30"><defs><linearGradient id="gradient-${index}" gradientTransform="rotate(${index % 6 * 24})"><stop stop-color="#6c9dbf"/><stop offset=".4" stop-color="#cc92af"/><stop offset="1" stop-color="#51dde4"/></linearGradient></defs>${geometry}</svg>`
}

function paintPage(kind) {
  const has = name => kind === name || (kind === 'combined' && ['typography','vector','effects'].includes(name))
  const styles = Object.entries(CSS).filter(([name])=>has(name)).map(([,rules])=>rules).join('\n')
  const cards = Array.from({length:96},(_,i)=>`<article>${has('vector')?icon(i):''}<code>${phrases[i%phrases.length]}</code></article>`).join('')
  return `<!doctype html><title>Local paint ${kind}</title>
    <style>body{margin:0;color:#f4f5f7;background:#192738;font:14px system-ui}
    main{display:grid;grid-template-columns:repeat(6,1fr);gap:3px;padding:4px}
    article{min-height:29px;padding:3px;white-space:nowrap;background:#304b6b;overflow:hidden} ${styles}</style>
    <main>${cards}</main>`
}
module.exports = {paintPage}
