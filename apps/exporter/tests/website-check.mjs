import {readFile,stat} from 'node:fs/promises'
import {resolve,dirname} from 'node:path'
import assert from 'node:assert/strict'

const root=resolve('website')
const files=['index.html','guide.html']
const pages=new Map(await Promise.all(files.map(async name=>[name,await readFile(resolve(root,name),'utf8') ])))
let resources=0,anchors=0
for(const [name,html] of pages){
  assert.match(html,/<html lang="zh-CN"/)
  assert.equal((html.match(/<h1[ >]/g)||[]).length,1)
  assert.match(html,/GitHub/)
  assert.match(html,/合成演示数据/)
  assert.doesNotMatch(html,/C:\\Users\\|Cookie\s*[:=]|Token\s*[:=]/)
  for(const match of html.matchAll(/(?:href|src|data-image)="([^"]+)"/g)){
    const href=match[1]
    if(/^https?:/.test(href))continue
    const [path,fragment]=href.split('#')
    const target=path==='./'?'index.html':path||name
    const absolute=resolve(dirname(resolve(root,name)),target)
    assert(absolute.startsWith(root),'local resource escapes site')
    assert((await stat(absolute)).isFile(),`missing resource ${href}`)
    resources++
    if(fragment){const source=await readFile(absolute,'utf8');assert(source.includes(`id="${fragment}"`),`missing anchor ${href}`);anchors++}
  }
  for(const match of html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g))assert.match(match[0],/rel="[^" ]*\s*[^\"]*noopener/)
}
const release=JSON.parse(await readFile(resolve(root,'release.json'),'utf8'))
assert.match(release.version,/^v\d+\.\d+\.\d+$/)
assert.match(release.sha256,/^sha256:[a-f0-9]{64}$/)
assert(release.downloadUrl.endsWith('/'+release.filename))
assert(release.downloadUrl.includes('/'+release.version+'/'))
const home=pages.get('index.html')
assert.equal((home.match(/class="chip"/g)||[]).length,9)
assert.equal((home.match(/assets\/platforms\//g)||[]).length,9)
assert.match(home,/多平台订单导出/)
assert.match(home,/id="security"/)
assert.match(home,/releases\/latest/,'working no-JS fallback')
assert.equal(release.netdiskUrl,'')
console.log(`PASS: ${files.length} pages, ${resources} local references, ${anchors} anchors, 9 platform logos, release consistency and fallback links.`)
