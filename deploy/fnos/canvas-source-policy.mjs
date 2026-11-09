import assert from 'node:assert/strict';
// This is the actual pinned native package's SBOM, not the wrapper's MIT field.
export function canvasSourcePolicy(sbom){
 const crates=sbom.components.filter(c=>c.purl?.startsWith('pkg:cargo/')&&c.name!=='canvas');
 const correspondingSource=[];
 for(const c of crates){
  const licenses=(c.licenses||[]).map(l=>l.expression||l.license?.id||'').join(' OR ');
  assert(licenses,'Canvas Rust component license missing: '+c.name);
  assert(c.hashes?.some(h=>h.alg==='SHA-256'&&/^[0-9a-f]{64}$/.test(h.content)),'Canvas Rust source checksum missing: '+c.name);
  if(/GPL|AGPL|LGPL/i.test(licenses)||(/MPL/i.test(licenses)&&licenses!=='MPL-2.0'))throw Error('Review new Canvas copyleft component: '+c.name+' '+licenses);
  if(licenses==='MPL-2.0')correspondingSource.push(c);
 }
 assert.deepEqual(correspondingSource.map(c=>c.name).sort(),['cssparser','cssparser-color','cssparser-macros','dtoa-short'].sort(),'Pinned Canvas MPL source set changed; review required');
 return {crates,correspondingSource,vendored:sbom.components.filter(c=>c['bom-ref']?.startsWith('skia-vendored:'))};
}
