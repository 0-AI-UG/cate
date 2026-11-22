const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '../..')
const destination = path.join(__dirname, 'app')
fs.mkdirSync(destination, {recursive:true})
fs.cpSync(path.join(root,'dist'), path.join(destination,'dist'), {recursive:true})
fs.copyFileSync(path.join(__dirname,'shell.cjs'), path.join(destination,'shell.cjs'))
const originalManifest = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'))
fs.writeFileSync(path.join(destination,'package.json'), JSON.stringify({...originalManifest,main:'shell.cjs'}))
const assets = path.join(destination,'dist/renderer/assets')
const browser = fs.readdirSync(assets).filter(name=>/^BrowserView-.*\.js$/.test(name))
if (browser.length !== 1) throw new Error('Expected one built BrowserView chunk')
const patch = (file, start, end, patchFile) => {
  const source = fs.readFileSync(file,'utf8')
  const begin = source.indexOf(start)
  const finish = end ? source.indexOf(end,begin) : begin+start.length
  if (begin<0 || finish<=begin) throw new Error('Missing build anchor '+file)
  fs.writeFileSync(file,source.slice(0,begin)+fs.readFileSync(path.join(__dirname,patchFile),'utf8')+source.slice(finish))
}
patch(path.join(assets,browser[0]),'function WebviewSlot(','function ErrorOverlay(','adapter/renderer.js')
patch(path.join(destination,'dist/preload/shell.js'),
  'electron.contextBridge.exposeInMainWorld("cateBrowserPage", createBrowserPageBridge());',null,'adapter/preload.cjs')
