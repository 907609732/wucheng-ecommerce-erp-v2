export function clipboardImages(transfer){
 const files=Array.from(transfer?.files||[]).filter(f=>f.type.startsWith('image/')||(!f.type&&/\.(png|jpe?g|webp)$/i.test(f.name||'')));
 return files.length?files:Array.from(transfer?.items||[]).filter(i=>i.kind==='file'&&i.type.startsWith('image/')).map(i=>i.getAsFile()).filter(Boolean);
}
