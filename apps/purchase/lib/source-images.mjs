import JSZip from 'jszip';
import {SaxesParser} from 'saxes';
import path from 'node:path';
import {MAX_IMAGE_BYTES} from './image-download.mjs';

const attr=(node,key)=>node?.attrs[key]||'';
const children=(node,name)=>(node?.children||[]).filter(n=>n.name===name);
const child=(node,name)=>children(node,name)[0];
const descend=(node,name)=>[...(node?.name===name?[node]:[]),...(node?.children||[]).flatMap(n=>descend(n,name))];
const text=node=>node?.text||'';
function xml(value){
 const parser=new SaxesParser({xmlns:true}),stack=[];let root;
 parser.on('doctype',()=>{throw Error('原表包含不支持的 XML 文档声明');});
 parser.on('opentag',tag=>{if(stack.length>100)throw Error('原表 XML 层级过深');const node={name:tag.local,attrs:Object.fromEntries(Object.values(tag.attributes).map(a=>[a.local,a.value])),children:[],text:''};if(stack.length)stack.at(-1).children.push(node);else root=node;stack.push(node);});
 parser.on('text',value=>{if(stack.length)stack.at(-1).text+=value;});parser.on('closetag',()=>stack.pop());parser.write(value).close();return root;
}
function zipPath(base,target){
 if(!target||target.includes('\\')||target.includes('\0'))throw Error('原表图片关联路径无效');
 const result=target.startsWith('/')?path.posix.normalize(target.slice(1)):path.posix.normalize(path.posix.join(path.posix.dirname(base),target));
 if(!result.startsWith('xl/'))throw Error('原表图片关联超出工作簿范围');return result;
}
const relPath=name=>path.posix.join(path.posix.dirname(name),'_rels',path.posix.basename(name)+'.rels');
export const isImageHeader=value=>/^(?:商品图片?|商品主图|宝贝图片?|图片|主图|image|photo|picture)(?:链接|地址|url|s)?\d*$/i.test(String(value||'').replace(/[\s_（）():：-]/g,''));
export function imageLinks(value){
 if(value==null)return [];
 if(typeof value==='object')return imageLinks(value.hyperlink||value.formula||value.text||'');
 const s=String(value).trim();
 // Literal URLs only; never evaluate spreadsheet expressions or scrape product pages.
 if(/^\s*(?:=|_xlfn\.)*(?:IMAGE|HYPERLINK)\s*\(/i.test(s))return [...s.matchAll(/"(https?:\/\/[^"\s]+)"/gi)].slice(0,1).map(m=>m[1]);
 return [...new Set(s.split(/\s+|[；;](?=https?:\/\/)/i).filter(v=>/^https?:\/\/[^<>"\s]+$/i.test(v)))];
}
const cellPosition=ref=>{const m=/^([A-Z]+)(\d+)$/i.exec(ref||'');if(!m)return null;return {row:Number(m[2]),column:[...m[1].toUpperCase()].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)};};

// Namespace-aware OOXML relationships also cover exports that ExcelJS cannot open.
export async function readImageWorkbook(buffer){
 const zip=await JSZip.loadAsync(buffer),entries=Object.values(zip.files);let total=0;
 if(entries.length>10000)throw Error('原表压缩内容过多');
 for(const file of entries){total+=file._data?.uncompressedSize||0;if(total>200*1024*1024)throw Error('原表解压后超过图片读取上限');}
 const readXml=async name=>{const file=zip.file(name);if(!file)return null;if(file._data?.uncompressedSize>16*1024*1024)throw Error('原表 XML 过大');return xml(await file.async('string'));};
 const relationships=async name=>new Map(children(await readXml(relPath(name)),'Relationship').map(r=>[attr(r,'Id'),{target:attr(r,'Target'),external:attr(r,'TargetMode')==='External'}]));
 const workbook=await readXml('xl/workbook.xml'),bookRels=await relationships('xl/workbook.xml');if(!workbook)throw Error('无法读取原始工作簿');
 const sheets=[];
 for(const sheet of children(child(workbook,'sheets'),'sheet')){
  const relation=bookRels.get(attr(sheet,'id'));if(!relation||relation.external)continue;
  const sheetPath=zipPath('xl/workbook.xml',relation.target),sheetXml=await readXml(sheetPath),rels=await relationships(sheetPath),images=[],links=[];
  for(const drawing of children(sheetXml,'drawing')){
   const rel=rels.get(attr(drawing,'id'));if(!rel||rel.external)continue;
   const drawingPath=zipPath(sheetPath,rel.target),drawingXml=await readXml(drawingPath),imageRels=await relationships(drawingPath);
   for(const anchor of drawingXml?.children||[]){
    const from=child(anchor,'from');if(!from)continue;
    const row=Number(text(child(from,'row')))+1,column=Number(text(child(from,'col')))+1;
    for(const blip of descend(anchor,'blip')){
     const imageRel=imageRels.get(attr(blip,'embed')||attr(blip,'link'));if(!imageRel)continue;
     if(imageRel.external)links.push({row,column,url:imageRel.target});
     else images.push({row,column,entry:zipPath(drawingPath,imageRel.target)});
    }
   }
  }
  for(const hyperlink of descend(sheetXml,'hyperlink')){
   const pos=cellPosition(attr(hyperlink,'ref')),rel=rels.get(attr(hyperlink,'id'));if(pos&&rel?.external)links.push({...pos,url:rel.target});
  }
  for(const cell of descend(sheetXml,'c')){
   const pos=cellPosition(attr(cell,'r'));if(pos)for(const url of imageLinks(text(child(cell,'f'))))links.push({...pos,url});
  }
  sheets.push({name:attr(sheet,'name'),images,links});
 }
 return {sheets,async image(entry){const file=zip.file(entry);if(!file)throw Error('原件中的图片文件缺失');if(file._data?.uncompressedSize>MAX_IMAGE_BYTES)throw Error('图片超过 10 MB，未保存');const buffer=await file.async('nodebuffer');if(buffer.length>MAX_IMAGE_BYTES)throw Error('图片超过 10 MB，未保存');return buffer;}};
}
