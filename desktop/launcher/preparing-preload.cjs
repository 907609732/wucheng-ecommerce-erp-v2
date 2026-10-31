const {ipcRenderer}=require('electron');
let status,paintRequested=false,paintQueued=false;
function render(){if(!status)return;document.getElementById('title').textContent=status.label;document.getElementById('detail').textContent=status.detail;const progress=document.querySelector('progress.lt-loading__progress'),measured=Number.isSafeInteger(status.processed)&&Number.isSafeInteger(status.total)&&status.processed>=0&&status.total>0&&status.processed<=status.total;if(measured){progress.max=status.total;progress.value=status.processed;}else{progress.removeAttribute('value');progress.removeAttribute('max');}progress.setAttribute('aria-valuetext',status.detail);document.querySelector('.lt-loading').setAttribute('aria-busy',String(status.phase!=='ready'));}
function acknowledgePaint(){if(!paintRequested||paintQueued||document.readyState==='loading')return;paintQueued=true;requestAnimationFrame(()=>requestAnimationFrame(()=>ipcRenderer.send('launcher:preparation-painted')));}
ipcRenderer.on('launcher:preparation',(_event,value)=>{status=value;if(document.readyState!=='loading')render();});
ipcRenderer.on('launcher:preparation-paint-check',()=>{paintRequested=true;acknowledgePaint();});
window.addEventListener('DOMContentLoaded',()=>{render();acknowledgePaint();});
