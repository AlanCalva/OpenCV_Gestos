// === UI ===
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx2d = canvas.getContext('2d');
const btnStart = document.getElementById('btnStart');
const btnStop  = document.getElementById('btnStop');
const statusEl = document.getElementById('status');
const blinkEl  = document.getElementById('blinkCount');
const browEl   = document.getElementById('browCount');
const mouthEl  = document.getElementById('mouthCount');
const fpsEl    = document.getElementById('fps');
const fpsBar   = document.getElementById('fpsBar');
const sensitivity = document.getElementById('sensitivity');
document.getElementById('year').textContent = new Date().getFullYear();

// === Estado ===
let stream = null;
let running = false;
let paintLoopId = null;
let mirror = true;
let currentDeviceId = null;

// ====== Controles (selector de cámara + espejo) ======
(function injectControls() {
  const panelCardBody = document.querySelector('#panel .card-body');
  if (!panelCardBody) return;
  panelCardBody.insertAdjacentHTML('beforeend', `<hr>
    <div class="row gy-2">
      <div class="col-12">
        <label class="form-label mb-1">Cámara</label>
        <select id="cameraSelect" class="form-select form-select-sm">
          <option value="">(Detectando cámaras...)</option>
        </select>
      </div>
      <div class="col-12 d-flex align-items-center gap-2">
        <div class="form-check form-switch">
          <input class="form-check-input" type="checkbox" id="mirrorToggle" checked>
          <label class="form-check-label" for="mirrorToggle">Espejo (flip horizontal)</label>
        </div>
      </div>
    </div>`);
  document.getElementById('mirrorToggle').addEventListener('change', e => { mirror = e.target.checked; });
  populateCameras();
})();

async function populateCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d => d.kind === 'videoinput');
    const sel = document.getElementById('cameraSelect');
    sel.innerHTML = '';
    if (cams.length === 0) { sel.innerHTML = `<option value="">No se encontraron cámaras</option>`; return; }
    cams.forEach((d, i) => { const opt = document.createElement('option'); opt.value=d.deviceId; opt.textContent=d.label||`Cámara ${i+1}`; sel.appendChild(opt); });
    if (!currentDeviceId) currentDeviceId = cams[0].deviceId;
    sel.value = currentDeviceId;
    sel.onchange = async (e) => { currentDeviceId = e.target.value||null; if(running){ await stopCamera(); await startCamera(); } };
  } catch(e){ console.warn('No se pudieron enumerar cámaras:', e); }
}

// ====== MediaPipe FaceMesh ======
const faceMesh = new FaceMesh({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
});
faceMesh.setOptions({ maxNumFaces:1, refineLandmarks:true, minDetectionConfidence:0.6, minTrackingConfidence:0.6 });
faceMesh.onResults(onResults);

// ====== LANDMARKS & UTILIDADES ======
const LEFT_EYE  = { left:33, right:133, top1:159, top2:158, bottom1:145, bottom2:153 };
const RIGHT_EYE = { left:362, right:263, top1:386, top2:385, bottom1:374, bottom2:380 };
const LEFT_BROW_POINTS  = [70,63,105];
const RIGHT_BROW_POINTS = [300,293,334];
const LEFT_EYE_TOP_POINTS  = [159,158];
const RIGHT_EYE_TOP_POINTS = [386,385];
const MOUTH_LEFT_CORNER  = 61;
const MOUTH_RIGHT_CORNER = 291;
const MOUTH_TOP_INNER    = 13;
const MOUTH_BOTTOM_INNER = 14;

function dist(a,b){const dx=a.x-b.x,dy=a.y-b.y;return Math.hypot(dx,dy);}
function ear(eye,lm){const p1=lm[eye.left],p4=lm[eye.right],p2=lm[eye.top1],p3=lm[eye.top2],p6=lm[eye.bottom1],p5=lm[eye.bottom2]; return (dist(p2,p6)+dist(p3,p5))/(2*dist(p1,p4));}
function avgPoint(lm,idxs){let x=0,y=0; for(const i of idxs){ x+=lm[i].x; y+=lm[i].y; } return {x:x/idxs.length,y:y/idxs.length};}
function eyeWidth(lm,eye){return dist(lm[eye.left], lm[eye.right]);}
function mar(lm){const left=lm[MOUTH_LEFT_CORNER], right=lm[MOUTH_RIGHT_CORNER]; const top=lm[MOUTH_TOP_INNER], bottom=lm[MOUTH_BOTTOM_INNER]; return dist(top,bottom)/dist(left,right);}
function browEyeGap(lm){ const browL=avgPoint(lm,LEFT_BROW_POINTS); const eyeTopL=avgPoint(lm,LEFT_EYE_TOP_POINTS); const gapL=Math.abs(browL.y-eyeTopL.y)/(eyeWidth(lm,LEFT_EYE)+1e-6); const browR=avgPoint(lm,RIGHT_BROW_POINTS); const eyeTopR=avgPoint(lm,RIGHT_EYE_TOP_POINTS); const gapR=Math.abs(browR.y-eyeTopR.y)/(eyeWidth(lm,RIGHT_EYE)+1e-6); return (gapL+gapR)/2; }
function scaleAround(base,pct){ return base*(1+(pct-50)/50*0.3); }

// ====== Estado de métricas ======
let smoothEAR=null, smoothMAR=null, smoothBrow=null;
const ALPHA = 0.6;

let blinkCount=0,browCount=0,mouthCount=0;
let eyesClosed=false;
let browBaseline=null,marBaseline=null,baselineFrames=0;
let lastTS=0;

// Buffers para reducir falsos positivos (cejas y boca)
let browFrameCounter=0, mouthFrameCounter=0;
const FRAME_THRESHOLD = 3;

// === Animación para los contadores ===
function animateCounter(el,value){ el.textContent=value; el.style.transform="scale(1.3)"; el.style.transition="transform 0.3s ease"; setTimeout(()=>{el.style.transform="scale(1)";},300); }

// ====== Cámara ======
async function startCamera(){
  if(running) return;
  try{
    const constraints={ video: currentDeviceId ? {deviceId:{exact:currentDeviceId}} : {facingMode:{ideal:'user'}, width:{ideal:960}, height:{ideal:540}}, audio:false};
    stream=await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject=stream;
    await new Promise(res=>{video.onloadedmetadata=()=>res();});
    await video.play();
    canvas.width=video.videoWidth||960;
    canvas.height=video.videoHeight||540;
    const camera=new Camera(video,{ onFrame: async()=>{ try{ await faceMesh.send({image:video}); } catch{} }, width:canvas.width, height:canvas.height});
    camera.start();
    const paint=()=>{ ctx2d.save(); if(mirror){ctx2d.translate(canvas.width,0); ctx2d.scale(-1,1);} ctx2d.fillStyle='#000'; ctx2d.fillRect(0,0,canvas.width,canvas.height); if(video.readyState>=2) ctx2d.drawImage(video,0,0,canvas.width,canvas.height); ctx2d.restore(); paintLoopId=requestAnimationFrame(paint);}
    paint();
    running=true;
    btnStart.disabled=true;
    btnStop.disabled=false;
    statusEl.textContent='Cámara encendida';
    populateCameras();
  }catch(err){ statusEl.textContent='Error al acceder a la cámara'; console.error('[CAM ERROR]',err);}
}

async function stopCamera(){
  if(!running) return;
  running=false;
  btnStart.disabled=false;
  btnStop.disabled=true;
  statusEl.textContent='Cámara apagada';
  if(paintLoopId){cancelAnimationFrame(paintLoopId); paintLoopId=null;}
  if(stream){stream.getTracks().forEach(t=>t.stop()); stream=null;}
  ctx2d.clearRect(0,0,canvas.width,canvas.height);
  browBaseline=marBaseline=null;
  baselineFrames=0;
  smoothEAR=smoothMAR=smoothBrow=null;
  eyesClosed=false;
  browFrameCounter=0;
  mouthFrameCounter=0;
}

// ====== Resultados FaceMesh ======
function onResults(results){
  const now=performance.now();
  if(lastTS){ const fps=1000/(now-lastTS); fpsEl.textContent=Math.round(fps); fpsBar.style.width=`${Math.min(100,Math.max(0,(fps/60)*100))}%`; }
  lastTS=now;

  if(!(results.multiFaceLandmarks && results.multiFaceLandmarks.length)){ statusEl.textContent='Rostro no detectado'; return; }

  const lm=results.multiFaceLandmarks[0];
  const leftEAR=ear(LEFT_EYE,lm);
  const rightEAR=ear(RIGHT_EYE,lm);
  const meanEAR=(leftEAR+rightEAR)/2;
  const mouthMAR=mar(lm);
  const gapBrow=browEyeGap(lm);

  smoothEAR=(smoothEAR==null)?meanEAR:smoothEAR*(1-ALPHA)+meanEAR*ALPHA;
  smoothMAR=(smoothMAR==null)?mouthMAR:smoothMAR*(1-ALPHA)+mouthMAR*ALPHA;
  smoothBrow=(smoothBrow==null)?gapBrow:smoothBrow*(1-ALPHA)+gapBrow*ALPHA;

  // Baseline inicial
  if(baselineFrames<50){
    browBaseline=browBaseline===null?smoothBrow:(browBaseline*0.9+smoothBrow*0.1);
    marBaseline=marBaseline===null?smoothMAR:(marBaseline*0.9+smoothMAR*0.1);
    baselineFrames++;
  }

  const earOn=scaleAround(0.19,sensitivity.valueAsNumber);
  const earOff=earOn+0.04;
  const marBase=(marBaseline??0.25);
  const marOn=scaleAround(marBase*1.45,sensitivity.valueAsNumber);
  const marOff=marOn*0.8;
  const browBase=(browBaseline??0.55);
  const browOn=scaleAround(browBase*1.10,sensitivity.valueAsNumber);
  const browOff=browOn*0.92;

  // Parpadeo (histéresis)
  if(!eyesClosed && smoothEAR<earOn) eyesClosed=true;
  if(eyesClosed && smoothEAR>earOff){ eyesClosed=false; blinkCount++; animateCounter(blinkEl,blinkCount); }

  // Cejas
  if(smoothBrow>browOn){ browFrameCounter++; } 
  else { if(browFrameCounter>=FRAME_THRESHOLD){ browCount++; animateCounter(browEl,browCount); } browFrameCounter=0; }

  // Boca
  if(smoothMAR>marOn){ mouthFrameCounter++; } 
  else { if(mouthFrameCounter>=FRAME_THRESHOLD){ mouthCount++; animateCounter(mouthEl,mouthCount); } mouthFrameCounter=0; }

  // Dibujo puntos
  ctx2d.save();
  if(mirror){ ctx2d.translate(canvas.width,0); ctx2d.scale(-1,1);}
  ctx2d.fillStyle='#00e5ff';
  for(let i=0;i<lm.length;i++){ const x=lm[i].x*canvas.width; const y=lm[i].y*canvas.height; ctx2d.beginPath(); ctx2d.arc(x,y,1.5,0,Math.PI*2); ctx2d.fill(); }
  ctx2d.restore();

  statusEl.textContent=`Rostro detectado • EAR=${smoothEAR.toFixed(3)} • MAR=${smoothMAR.toFixed(3)} • GAP=${smoothBrow.toFixed(3)}`;
}

// ====== Botones ======
btnStart.addEventListener('click', startCamera);
btnStop.addEventListener('click', stopCamera);
window.addEventListener('beforeunload', stopCamera);
