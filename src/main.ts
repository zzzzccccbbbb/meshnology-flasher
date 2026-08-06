import './style.css';
import { detectBrowserSupport, validateSegments, type FirmwareSegment } from './flasher';

type Segment = FirmwareSegment & { file?: File };
const app = document.querySelector<HTMLDivElement>('#app')!;
let segments: Segment[] = [];
let mode: 'single'|'multi' = 'single';
let connected: any = null;

app.innerHTML = `
  <div class="shell">
    <header><div class="brand"><span class="mark">M</span><div><b>Meshnology</b><small>LOCAL WEB FLASHER</small></div></div><a href="https://github.com/" target="_blank">开源项目 ↗</a></header>
    <main>
      <section class="hero"><div><p class="eyebrow">OPEN SOURCE · LOCAL ONLY</p><h1>Firmware flashing,<br><em>without the friction.</em></h1><p class="lead">无需登录、无需上传。固件始终留在你的电脑上，直接通过浏览器写入 ESP32-S3 或 Nordic nRF52。</p></div><div class="orb"><span>LOCAL<br>ONLY</span></div></section>
      <section class="grid">
        <div class="card device"><div class="card-head"><span class="step">01</span><h2>连接设备</h2><span id="status" class="badge warn">未连接</span></div><p>使用 Chrome 或 Edge，通过 WebUSB 访问你的开发板。</p><button id="connect" class="btn primary">连接 USB 设备 <span>→</span></button><div id="deviceInfo" class="device-info hidden"></div></div>
        <div class="card firmware"><div class="card-head"><span class="step">02</span><h2>选择固件</h2></div><div class="tabs"><button data-mode="single" class="tab active">单个合并文件</button><button data-mode="multi" class="tab">多个文件 + 偏移</button></div><div id="drop" class="drop"><div class="upload-icon">↑</div><b>拖放 .bin 文件到这里</b><span>或 <label for="fileInput">从电脑选择</label></span><input id="fileInput" type="file" accept=".bin,application/octet-stream" hidden></div><div id="segments"></div></div>
      </section>
      <section class="card flash"><div class="card-head"><span class="step">03</span><h2>开始烧录</h2><span id="privacy">● 本地处理</span></div><div class="flash-row"><div><p id="summary">请选择固件文件后开始</p><div class="progress"><i id="bar"></i></div><small id="log">等待操作…</small></div><button id="flash" class="btn dark" disabled>开始烧录 <span>→</span></button></div></section>
      <div class="notice">⚠ <span>烧录过程中请勿断开 USB 连接。若设备未被识别，请按住 BOOT 键后重新插入设备。</span></div>
    </main>
    <footer><span>Meshnology Web Flasher v0.1.0</span><span>固件不会离开此设备 · MIT License</span></footer>
  </div>`;

const status = document.querySelector('#status')!;
const info = document.querySelector('#deviceInfo')!;
const log = document.querySelector('#log')!;
const bar = document.querySelector<HTMLDivElement>('#bar')!;
const summary = document.querySelector('#summary')!;
const flashBtn = document.querySelector<HTMLButtonElement>('#flash')!;
const drop = document.querySelector('#drop')!;
const list = document.querySelector('#segments')!;

function render() {
  list.innerHTML = segments.map((s,i)=>`<div class="file-row"><span class="file-icon">▣</span><div><b>${s.name}</b><small>${formatBytes(s.size)}${mode==='multi' ? ` · 地址 <input data-offset="${i}" value="0x${s.offset.toString(16).padStart(4,'0')}" />` : ''}</small></div><button data-remove="${i}">×</button></div>`).join('');
  list.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(b=>b.onclick=()=>{segments.splice(Number(b.dataset.remove),1);render();});
  list.querySelectorAll<HTMLInputElement>('[data-offset]').forEach(input=>input.onchange=()=>{ const i=Number(input.dataset.offset); segments[i].offset=parseInt(input.value,16)||0; render(); });
  summary.textContent = segments.length ? `${segments.length} 个文件 · ${formatBytes(segments.reduce((n,s)=>n+s.size,0))}` : '请选择固件文件后开始';
  flashBtn.disabled = !segments.length;
}
function formatBytes(n:number){return n<1024?`${n} B`:`${(n/1024/1024).toFixed(2)} MB`;}
async function addFiles(files: FileList|File[]){ for(const file of Array.from(files)){if(!file.name.toLowerCase().endsWith('.bin'))continue; segments.push({name:file.name,size:file.size,offset:mode==='single'?0:0x10000,file});} render(); }

document.querySelector('#fileInput')!.addEventListener('change',e=>addFiles((e.target as HTMLInputElement).files||[]));
drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('drag');});
drop.addEventListener('dragleave',()=>drop.classList.remove('drag'));
drop.addEventListener('drop',e=>{const de=e as DragEvent; de.preventDefault();drop.classList.remove('drag'); if(de.dataTransfer) addFiles(de.dataTransfer.files);});
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(tab=>tab.onclick=()=>{mode=tab.dataset.mode as any; document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));tab.classList.add('active');render();});

document.querySelector('#connect')!.addEventListener('click',async()=>{ const support=detectBrowserSupport(navigator as any); if(!support.webUsb){status.textContent='浏览器不支持';status.className='badge error';log.textContent='请使用最新版 Chrome 或 Edge。';return;} try {connected=await (navigator as any).usb.requestDevice({filters:[]}); status.textContent='已连接';status.className='badge ok';info.textContent=`${connected.productName||'USB 设备'} · ${connected.serialNumber||'已授权'}`;info.classList.remove('hidden');log.textContent='USB 设备已授权，可以开始烧录。';}catch{log.textContent='用户取消了设备选择。';} });
flashBtn.addEventListener('click',async()=>{const errors=validateSegments(segments);if(errors.length){log.textContent=errors.join('；');return;}if(!connected){log.textContent='请先连接 USB 设备。';return;} flashBtn.disabled=true;bar.style.width='0%';log.textContent='正在准备本地固件…';for(let i=1;i<=20;i++){await new Promise(r=>setTimeout(r,35));bar.style.width=`${i*5}%`;}log.textContent='USB 设备已连接，但 ESP32-S3/nRF52 Bootloader 写入协议适配器尚未配置。';flashBtn.disabled=false;});
render();




