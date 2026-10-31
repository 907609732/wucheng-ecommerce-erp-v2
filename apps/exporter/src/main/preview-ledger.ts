import fs from 'node:fs'
import path from 'node:path'
import {Store} from '../core/store'

// Bundled alongside the normal Electron entry so the fixed external Node
// runtime can initialize this module with its existing domain Store.
export function initializeEmptyPreviewExporter(directory:string):void {
  const local=process.env.LOCALAPPDATA
  if(process.env.LINGTU_AGENT_PREVIEW!=='1'||!local||!path.isAbsolute(local))throw Error('Preview initialization is not enabled')
  const parent=path.join(path.resolve(local),'WuchengAgentBeta-preview','data'),dir=path.resolve(directory)
  if(path.dirname(dir)!==parent||!/^\.preview-exporter-[a-zA-Z0-9_-]+$/.test(path.basename(dir)))throw Error('Preview initialization path is not isolated')
  let current=path.parse(dir).root
  for(const part of dir.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink())throw Error('Linked preview initialization path')}
  if(!fs.statSync(dir).isDirectory()||fs.readdirSync(dir).length)throw Error('Preview initialization requires an empty staging directory')
  const store=new Store(path.join(dir,'orders.sqlite'))
  store.close()
}
