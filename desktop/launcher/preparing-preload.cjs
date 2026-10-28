const {ipcRenderer}=require('electron');
let status;
function render(){if(!status)return;document.getElementById('title').textContent=status.label;document.getElementById('detail').textContent=status.detail;}
ipcRenderer.on('launcher:preparation',(_event,value)=>{status=value;if(document.readyState!=='loading')render();});
window.addEventListener('DOMContentLoaded',render);
