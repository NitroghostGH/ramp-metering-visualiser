"use strict";
/* Queensland Smart Motorways visualiser --------------------------------------
   Multi-ramp METANET corridors with local ALINEA, HERO coordination and VSL.
   The Django backend returns exact simulations for six scenarios (none/alinea/
   hero × vsl on/off); this plays them back on an animated schematic + map. */

const app  = document.getElementById("app");
const DEF   = JSON.parse(app.dataset.defaults);
const CORRS = JSON.parse(app.dataset.corridors);
const COLORS = { none:"#f2607a", alinea:"#54d6a0", hero:"#f3c14a" };

const SLIDERS = ["demand_level","alinea_gain","target_occ","control_period","hero_master","vsl_gain"];
const FMT = {
  demand_level: v => (+v).toFixed(0)+"%",
  target_occ:   v => (+v).toFixed(1),
  hero_master:  v => (+v).toFixed(2),
};

let DATA = null;
let corridorId = DEF.corridor;
let control = "none";          // none | alinea | hero
let vslOn = false;
let view = "schematic";
let frame = 0, playing = false, rate = 1, lastTS = 0;
let demandProfile = null;      // uploaded {time_s, mainline, ramps} or null

const scnKey = () => control + (vslOn ? "_vsl" : "");

/* ------------------------------------------------------------ corridor picker */
function initCorridors(){
  const box = document.getElementById("corridor-list");
  box.innerHTML = "";
  for(const c of CORRS){
    const el = document.createElement("button");
    el.className = "corridor-card" + (c.id===corridorId ? " active":"");
    el.dataset.id = c.id;
    const sample = c.representative ? `<span class="sample-badge" title="Representative example, not survey data">sample</span>` : "";
    el.innerHTML = `<div class="cc-top"><span class="route-badge ${c.route.toLowerCase()}">${c.route}</span>`
      + `<span class="cc-name">${c.name.replace(/\s*\(.*\)/,'')}</span>${sample}</div>`
      + `<div class="cc-meta">${c.direction}</div>`
      + `<div class="cc-meta">${c.length_km} km · ${c.on_ramps} metered on-ramps · up to ${c.lanes_max} lanes</div>`;
    el.addEventListener("click", ()=>{
      corridorId = c.id;
      document.querySelectorAll(".corridor-card").forEach(x=>x.classList.remove("active"));
      el.classList.add("active");
      if(demandProfile){ demandProfile=null; setDataStatus("Using the built-in AM-peak profile.",false); }
      run();
    });
    box.appendChild(el);
  }
}

/* ------------------------------------------------------------ sliders */
function initSliders(){
  for(const id of SLIDERS){
    const el = document.getElementById(id);
    if(id==="demand_level") el.value = Math.round(DEF.demand_level*100);
    else if(DEF[id]!==undefined) el.value = DEF[id];
    const out = document.getElementById("v-"+id);
    const show = ()=> out.textContent = (FMT[id]||(x=>x))(el.value);
    show();
    el.addEventListener("input", ()=>{ show(); scheduleRun(); });
  }
  const vsl = document.getElementById("vsl_on");
  vsl.checked = vslOn;
  vsl.addEventListener("change", ()=>{ vslOn = vsl.checked; refreshAll(); });
}

let runTimer=null;
function scheduleRun(){ clearTimeout(runTimer); runTimer=setTimeout(run,240); }

function collect(){
  const c = {
    corridor: corridorId,
    demand_level: parseFloat(document.getElementById("demand_level").value)/100,
    alinea_gain: parseFloat(document.getElementById("alinea_gain").value),
    target_occ:  parseFloat(document.getElementById("target_occ").value),
    control_period: parseFloat(document.getElementById("control_period").value),
    hero_master: parseFloat(document.getElementById("hero_master").value),
    vsl_gain: parseFloat(document.getElementById("vsl_gain").value),
  };
  if(demandProfile) c.demand_profile = demandProfile;
  return c;
}

/* ------------------------------------------------------------ run */
async function run(){
  try{
    const res = await fetch("/api/simulate",{method:"POST",
      headers:{"Content-Type":"application/json"}, body:JSON.stringify(collect())});
    DATA = await res.json();
    precompute();
    frame = 0; resetParticles();
    setCaption();
    buildMap();
    refreshAll();
    if(!playing) togglePlay(true);
  }catch(e){ console.error(e); }
}

// derived per-scenario arrays (total ramp queue over time)
function precompute(){
  for(const key of Object.keys(DATA.results)){
    const R = DATA.results[key];
    const n = R.t.length, nr = R.ramp_queue.length;
    const tot = new Array(n).fill(0);
    for(let j=0;j<nr;j++) for(let i=0;i<n;i++) tot[i]+=R.ramp_queue[j][i];
    R.total_ramp_q = tot.map(x=>Math.round(x));
    R.total_ramp_q_max = Math.max(...tot, 0);
  }
}

function setCaption(){
  const m = DATA.meta;
  const src = m.demand_source==="uploaded"
    ? `<span style="color:var(--vsl)">Demand: uploaded profile.</span>`
    : `<span style="color:var(--ink-faint)">Demand: built-in AM-peak (×${m.demand_scale}).</span>`;
  document.getElementById("corridor-caption").innerHTML =
    `<b>${m.name}</b> — ${m.direction}. ${m.note} ${src} `
    + `<span style="color:var(--ink-faint)">Bottleneck at segment ${m.bottleneck_seg+1}/${m.n_segments}.</span>`;
}

function refreshAll(){
  if(!DATA) return;
  document.querySelectorAll("#scenario-tabs button").forEach(b=>
    b.classList.toggle("active", b.dataset.scn===control));
  fillScoreboard();
  drawCharts();
  renderFrame();
}

/* ------------------------------------------------------------ scoreboard */
function fillScoreboard(){
  const R = DATA.results;
  const cols = ["none","alinea","hero"];
  const g = id=>document.getElementById(id);
  const suffix = vslOn ? "_vsl" : "";
  for(const c of cols){
    const r = R[c+suffix];
    g(`s-speed-${c}`).textContent = r.mean_speed.toFixed(1);
    g(`s-cong-${c}`).textContent  = (r.congested_frac*100).toFixed(0)+"%";
    g(`s-flow-${c}`).textContent  = Math.round(r.throughput);
    g(`s-ttt-${c}`).textContent   = r.total_travel_time.toFixed(0);
    g(`s-queue-${c}`).textContent = r.max_ramp_queue.toFixed(0);
  }
  markBest(["s-speed-none","s-speed-alinea","s-speed-hero"], Math.max);
  markBest(["s-cong-none","s-cong-alinea","s-cong-hero"], Math.min, true);
  markBest(["s-flow-none","s-flow-alinea","s-flow-hero"], Math.max);
  markBest(["s-ttt-none","s-ttt-alinea","s-ttt-hero"], Math.min);
  g("score-vsl-note").textContent = vslOn ? "· with VSL" : "";

  const base=R["none"+suffix], best=R["hero"+suffix];
  const dSpd=best.mean_speed-base.mean_speed;
  const dCong=(base.congested_frac-best.congested_frac)*100;
  const v=g("verdict");
  if(dSpd>0.4 || dCong>1){
    v.innerHTML = `On this corridor, <b>HERO${vslOn?" + VSL":""}</b> raises mean speed by `
      + `<b>${dSpd.toFixed(1)} km/h</b> and cuts time-in-congestion by `
      + `<b>${dCong.toFixed(0)} percentage points</b> versus no control — `
      + `HERO shares storage across ramps so none overflows onto the arterial.`;
  }else{
    v.innerHTML = `Demand is below the breakdown point here — the motorway flows freely and metering has little to do. `
      + `Raise the demand level to force a bottleneck.`;
  }
}
function markBest(ids, fn, isPct){
  const vals = ids.map(id=>parseFloat(document.getElementById(id).textContent));
  const best = fn(...vals);
  ids.forEach((id,i)=>document.getElementById(id).classList.toggle("best", Math.abs(vals[i]-best)<1e-6));
}

/* ------------------------------------------------------------ canvas util */
function setupCanvas(cv){
  const dpr=window.devicePixelRatio||1, r=cv.getBoundingClientRect();
  cv.width=r.width*dpr; cv.height=r.height*dpr;
  const ctx=cv.getContext("2d"); ctx.setTransform(dpr,0,0,dpr,0,0);
  return {ctx,w:r.width,h:r.height};
}
function speedColor(v){
  const r=Math.max(0,Math.min(1,v/DATA.meta.v_free));
  return `hsl(${8+132*r},72%,${40+18*r}%)`;
}
const MONO="11px ui-monospace, Menlo, Consolas, monospace";

/* ------------------------------------------------------------ charts */
function drawCharts(){
  drawMini("c-speed", k=>DATA.results[k].mean_speed_t, {});
  drawMini("c-queue", k=>DATA.results[k].total_ramp_q, {});
  drawHeat();
}
function drawMini(id, pick, opts){
  const cv=document.getElementById(id); const {ctx,w,h}=setupCanvas(cv);
  ctx.clearRect(0,0,w,h);
  if(!DATA) return;
  const suffix=vslOn?"_vsl":"";
  const series=["none","alinea","hero"].map(c=>({color:COLORS[c],data:pick(c+suffix)}));
  const pad={l:34,r:8,t:10,b:22}, iw=w-pad.l-pad.r, ih=h-pad.t-pad.b;
  let ymax=-Infinity,ymin=Infinity;
  for(const s of series) for(const v of s.data){ if(v>ymax)ymax=v; if(v<ymin)ymin=v; }
  ymin=Math.min(ymin,0); ymax=(ymax*1.08)||1;
  const n=series[0].data.length;
  const X=i=>pad.l+iw*i/(n-1), Y=v=>pad.t+ih*(1-(v-ymin)/(ymax-ymin));
  ctx.strokeStyle="#1c2532"; ctx.fillStyle="#5c6a7e"; ctx.font=MONO; ctx.lineWidth=1;
  for(let g=0;g<=2;g++){ const val=ymin+(ymax-ymin)*g/2,y=Y(val);
    ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(w-pad.r,y);ctx.stroke();
    ctx.fillText(val.toFixed(val<10?1:0),3,y+3); }
  ctx.lineWidth=1.6;
  for(const s of series){ ctx.strokeStyle=s.color; ctx.beginPath();
    for(let i=0;i<n;i++){const x=X(i),y=Y(s.data[i]); i?ctx.lineTo(x,y):ctx.moveTo(x,y);} ctx.stroke(); }
  const fi=Math.min(Math.floor(frame),n-1), cx=X(fi);
  ctx.strokeStyle="rgba(232,237,245,.35)";ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(cx,pad.t);ctx.lineTo(cx,pad.t+ih);ctx.stroke();
  // x-axis time ticks (minutes)
  const tot=Math.round(DATA.meta.horizon/60);
  ctx.fillStyle="#5c6a7e"; ctx.font=MONO;
  ctx.textAlign="left";   ctx.fillText("0", pad.l, h-5);
  ctx.textAlign="center"; ctx.fillText(""+Math.round(tot/2), pad.l+iw/2, h-5);
  ctx.textAlign="right";  ctx.fillText(tot+" min", w-pad.r, h-5);
  ctx.textAlign="left";
}

function drawHeat(){
  const cv=document.getElementById("c-heat"); const {ctx,w,h}=setupCanvas(cv);
  ctx.clearRect(0,0,w,h);
  if(!DATA) return;
  const R=DATA.results[scnKey()];
  document.getElementById("heat-scn").textContent =
    ({none:"No control",alinea:"Local ALINEA",hero:"HERO"})[control] + (vslOn?" + VSL":"");
  const grid=R.seg_v, n=grid.length, N=grid[0].length;
  const padL=4, padR=4, iw=w-padL-padR, ih=h-2;
  const colW=iw/n, rowH=ih/N;
  for(let i=0;i<n;i++) for(let s=0;s<N;s++){
    ctx.fillStyle=speedColor(grid[i][s]);
    ctx.fillRect(padL+i*colW, 1+s*rowH, colW+0.6, rowH+0.6);
  }
  // ramp markers on the left edge
  ctx.fillStyle="rgba(255,255,255,.85)"; ctx.font=MONO;
  for(const o of DATA.meta.on_ramps){
    const y=1+o.seg*rowH+rowH/2;
    ctx.fillStyle="rgba(12,15,22,.7)"; ctx.fillRect(padL,y-6,86,12);
    ctx.fillStyle="#e8edf5"; ctx.fillText("▸ "+o.name.slice(0,13), padL+3, y+3);
  }
  // time cursor
  const cx=padL+iw*Math.min(frame,n-1)/(n-1);
  ctx.strokeStyle="rgba(255,255,255,.5)";ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(cx,1);ctx.lineTo(cx,h-1);ctx.stroke();
}

/* ------------------------------------------------------------ schematic */
let particles=[], spawnAcc=0, rampAcc=[];
function resetParticles(){ particles=[]; spawnAcc=0; rampAcc=(DATA?DATA.meta.on_ramps.map(()=>0):[]); }

function demandScale(t){ // mirror engine.demand_scale (trapezoid)
  const H=DATA.meta.horizon, b=0.55;
  const t0=0.10*H,t1=0.30*H,t2=0.62*H,t3=0.85*H;
  if(t<t0)return b; if(t<t1)return b+(1-b)*(t-t0)/(t1-t0);
  if(t<t2)return 1; if(t<t3)return 1+(b-1)*(t-t2)/(t3-t2); return b;
}
function segAt(xKm){ const m=DATA.meta; return Math.max(0,Math.min(m.n_segments-1,Math.floor(xKm/m.seg_length))); }
function frameIdx(){ return Math.min(Math.floor(frame), DATA.results[scnKey()].t.length-1); }

function advanceParticles(simSec){
  if(!DATA) return;
  const m=DATA.meta, R=DATA.results[scnKey()], fi=frameIdx();
  const hours=simSec/3600, roadLen=m.n_segments*m.seg_length;
  const V=R.seg_v[fi];
  for(const c of particles){ const v=V[segAt(c.x)]; c.spd=v; c.x+=v*hours; }
  particles=particles.filter(c=>c.x<roadLen);
  if(particles.length>1600) particles.splice(0,particles.length-1600);
  // mainline spawn ∝ entrance flow
  spawnAcc += R.flow_in[fi]*hours;
  while(spawnAcc>=1){ spawnAcc-=1; particles.push({x:0,lf:Math.random(),spd:m.v_free}); }
  // ramp merge spawn ∝ approx ramp discharge
  const t=fi*m.step;
  m.on_ramps.forEach((o,j)=>{
    const meter = control==="none" ? 1e9 : R.ramp_meter[j][fi];
    const dem = ramFullDemand(j)*demandScale(t);
    const q = R.ramp_queue[j][fi];
    const merge = Math.min(meter, q>4 ? meter : dem);
    rampAcc[j]=(rampAcc[j]||0)+merge*hours;
    while(rampAcc[j]>=1){ rampAcc[j]-=1;
      particles.push({x:o.seg*m.seg_length+0.02, lf:0.85, spd:V[o.seg]}); }
  });
}
function ramFullDemand(j){
  const r=DATA.meta.ramps.find(r=>r.kind==="on" && r.seg===DATA.meta.on_ramps[j].seg);
  return r?r.demand:600;
}

function drawRoad(){
  const cv=document.getElementById("road"); const {ctx,w,h}=setupCanvas(cv);
  ctx.clearRect(0,0,w,h);
  if(!DATA) return;
  const m=DATA.meta, R=DATA.results[scnKey()], fi=frameIdx();
  const V=R.seg_v[fi];
  const roadLen=m.n_segments*m.seg_length;
  const marginX=14, rw=w-marginX*2;
  const lanePx=11, maxLanes=Math.max(...m.lanes);
  const baseline=Math.round(h*0.42);           // road sits on this line
  const kmToX=km=>marginX+rw*km/roadLen;
  const segX=i=>marginX+rw*i/m.n_segments;

  // --- road surface with a TAPERED top edge, so a lane drop reads as a merge,
  //     not an abrupt vertical step. Control points sit at each segment centre. ---
  const topPts=[[marginX, baseline-m.lanes[0]*lanePx]];
  for(let i=0;i<m.n_segments;i++) topPts.push([(segX(i)+segX(i+1))/2, baseline-m.lanes[i]*lanePx]);
  topPts.push([marginX+rw, baseline-m.lanes[m.n_segments-1]*lanePx]);
  const topY=x=>{
    for(let k=0;k<topPts.length-1;k++){ const a=topPts[k],bb=topPts[k+1];
      if(x>=a[0]&&x<=bb[0]){ const t=(x-a[0])/((bb[0]-a[0])||1); return a[1]+(bb[1]-a[1])*t; } }
    return topPts[topPts.length-1][1];
  };
  // speed-coloured fill per segment, following the tapered top
  for(let i=0;i<m.n_segments;i++){
    const x0=segX(i), x1=segX(i+1);
    ctx.fillStyle=speedColor(V[i]); ctx.globalAlpha=0.24;
    ctx.beginPath(); ctx.moveTo(x0,topY(x0)); ctx.lineTo(x1,topY(x1));
    ctx.lineTo(x1,baseline); ctx.lineTo(x0,baseline); ctx.closePath(); ctx.fill();
    ctx.globalAlpha=1;
  }
  // dashed lane dividers, drawn only across segments where that lane exists
  ctx.setLineDash([9,11]); ctx.strokeStyle="rgba(255,255,255,.12)"; ctx.lineWidth=1;
  for(let j=1;j<maxLanes;j++){ const y=baseline-j*lanePx; let run=null;
    for(let i=0;i<=m.n_segments;i++){ const has=i<m.n_segments && m.lanes[i]>j;
      if(has&&run===null) run=segX(i);
      else if(!has&&run!==null){ ctx.beginPath(); ctx.moveTo(run,y); ctx.lineTo(segX(i),y); ctx.stroke(); run=null; } }
  }
  ctx.setLineDash([]);
  // tapered top edge + straight baseline
  ctx.strokeStyle="#3a4757"; ctx.lineWidth=1.5;
  ctx.beginPath(); topPts.forEach((p,k)=>k?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1])); ctx.stroke();
  ctx.strokeStyle="#26303f";
  ctx.beginPath(); ctx.moveTo(marginX,baseline); ctx.lineTo(marginX+rw,baseline); ctx.stroke();

  // speed-limit labels where the section changes
  ctx.font=MONO; ctx.textAlign="center";
  let prev=null;
  for(let i=0;i<m.n_segments;i++){
    if(m.vlimit[i]!==prev){
      const x=segX(i);
      ctx.fillStyle="#93a1b5";
      ctx.fillText(m.vlimit[i]+"", x+16, baseline-maxLanes*lanePx-6);
      prev=m.vlimit[i];
    }
  }
  ctx.textAlign="left"; ctx.fillStyle="#5c6a7e";
  ctx.fillText("▸ traffic flow", marginX, 14);
  ctx.textAlign="right"; ctx.fillText("km/h zones ▴", marginX+rw-4, baseline-maxLanes*lanePx-6);
  ctx.textAlign="left";

  // vehicles
  for(const c of particles){
    const seg=segAt(c.x), lanes=m.lanes[seg], lh=lanes*lanePx;
    const x=kmToX(c.x);
    // keep vehicles below the (possibly tapered) road surface
    const y=Math.max(baseline - (0.12+c.lf*0.76)*lh, topY(x)+3);
    ctx.fillStyle=speedColor(c.spd);
    roundRect(ctx,x-2.4,y-1.6,5,3.4,1.2); ctx.fill();
  }

  // bottleneck detector
  const bx=segX(m.bottleneck_seg+1);
  ctx.strokeStyle="rgba(92,200,255,.7)"; ctx.setLineDash([3,3]);
  ctx.beginPath(); ctx.moveTo(bx,baseline-maxLanes*lanePx-2); ctx.lineTo(bx,baseline+6); ctx.stroke();
  ctx.setLineDash([]); ctx.fillStyle="rgba(92,200,255,.85)"; ctx.font=MONO;
  ctx.fillText("bottleneck", bx+3, baseline-maxLanes*lanePx+2);

  // on-ramps + meters + queues
  const t=fi*m.step;
  m.on_ramps.forEach((o,j)=>{
    const mx=segX(o.seg)+ (segX(o.seg+1)-segX(o.seg))*0.5;
    const lanes=m.lanes[o.seg], lh=lanes*lanePx;
    const mergeY=baseline-2;
    const rampBottom=baseline+58, rampStartX=mx-70;
    ctx.strokeStyle="#2b3646"; ctx.lineWidth=6; ctx.lineCap="round";
    ctx.beginPath(); ctx.moveTo(rampStartX,rampBottom); ctx.lineTo(mx,mergeY); ctx.stroke();
    ctx.lineCap="butt"; ctx.lineWidth=1;

    // queue dots
    const q=R.ramp_queue[j][fi];
    const dots=Math.min(20,Math.round(q/6));
    for(let d=0;d<dots;d++){
      const tt=0.42-d*0.045; if(tt<0)break;
      const qx=rampStartX+(mx-rampStartX)*tt, qy=rampBottom+(mergeY-rampBottom)*tt;
      ctx.fillStyle="#f2607a"; roundRect(ctx,qx-2.6,qy-1.8,5.2,3.6,1.1); ctx.fill();
    }
    // meter light
    const meter=control==="none"?9999:R.ramp_meter[j][fi];
    const dem=ramFullDemand(j)*demandScale(t);
    const restricting = control!=="none" && meter < dem-30;
    drawMeter(ctx, rampStartX-4, rampBottom-6, !restricting);
    // name
    ctx.fillStyle="#7d8ba0"; ctx.font=MONO; ctx.textAlign="center";
    const short=o.name.replace(/^Off:\s*/,'');
    ctx.fillText(short.length>16?short.slice(0,15)+"…":short, mx, rampBottom+14);
    ctx.textAlign="left";
  });

  // off-ramps (draw upward exit arrows)
  m.ramps.filter(r=>r.kind==="off").forEach(o=>{
    const mx=segX(o.seg), lh=m.lanes[o.seg]*lanePx;
    ctx.strokeStyle="#2b3646"; ctx.lineWidth=5; ctx.lineCap="round";
    ctx.beginPath(); ctx.moveTo(mx,baseline-lh+2); ctx.lineTo(mx-34,baseline-lh-30); ctx.stroke();
    ctx.lineCap="butt"; ctx.lineWidth=1;
    ctx.fillStyle="#5c6a7e"; ctx.font=MONO; ctx.textAlign="right";
    ctx.fillText(o.name.replace(/^Off:\s*/,'')+" ⤴", mx-6, baseline-lh-34); ctx.textAlign="left";
  });
}

function drawMeter(ctx,x,y,green){
  ctx.fillStyle="#0d1119"; roundRect(ctx,x,y,11,20,2.5); ctx.fill();
  ctx.strokeStyle="#26303f"; ctx.stroke();
  ctx.fillStyle=green?"#3a1420":"#f2607a";
  ctx.beginPath();ctx.arc(x+5.5,y+5.5,2.6,0,7);ctx.fill();
  ctx.fillStyle=green?"#54d6a0":"#123a2c";
  ctx.beginPath();ctx.arc(x+5.5,y+14,2.6,0,7);ctx.fill();
}
function roundRect(ctx,x,y,w,h,r){
  ctx.beginPath();ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();
}

/* ------------------------------------------------------------ map (Leaflet) */
let map=null, mapLayers=[], mapReady=false, lineBounds=null;
function buildMap(){
  if(typeof L==="undefined"){ // offline / blocked
    const el=document.getElementById("map");
    el.outerHTML='<div id="map" class="map-fallback">Map tiles need an internet connection.<br>The Schematic view works fully offline.</div>';
    return;
  }
  const m=DATA.meta;
  if(!map){
    map=L.map("map",{zoomControl:true,attributionControl:false});
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",{maxZoom:18}).addTo(map);
    mapReady=true;
  }
  mapLayers.forEach(l=>map.removeLayer(l)); mapLayers=[];
  const line=L.polyline(m.geo,{color:"#5cc8ff",weight:5,opacity:.85}).addTo(map);
  mapLayers.push(line);
  lineBounds=line.getBounds();
  map.fitBounds(lineBounds,{padding:[30,30]});
  // ramp markers stored for live recolour
  m.on_ramps.forEach((o,j)=>{
    const mk=L.circleMarker(o.geo,{radius:7,color:"#0c0f16",weight:2,fillOpacity:1,fillColor:"#54d6a0"})
      .bindTooltip(o.name,{direction:"top"}).addTo(map);
    mk._rampIdx=j; mapLayers.push(mk);
  });
}
function updateMap(){
  if(!mapReady||view!=="map"||!DATA) return;
  const R=DATA.results[scnKey()], fi=frameIdx();
  mapLayers.forEach(l=>{ if(l._rampIdx!==undefined){
    const occ=R.ramp_occ[l._rampIdx][fi];
    const spd=DATA.results[scnKey()].seg_v[fi][DATA.meta.on_ramps[l._rampIdx].seg];
    l.setStyle({fillColor:speedColor(spd)});
    const q=R.ramp_queue[l._rampIdx][fi];
    l.setRadius(6+Math.min(10,q/12));
  }});
}

/* ------------------------------------------------------------ frame + readouts */
function renderFrame(){
  if(!DATA) return;
  if(view==="schematic") drawRoad(); else updateMap();
  drawMini("c-speed", k=>DATA.results[k].mean_speed_t,{});
  drawMini("c-queue", k=>DATA.results[k].total_ramp_q,{});
  drawHeat();
  if(!document.getElementById("info-modal").classList.contains("hidden")) drawFD();
  const R=DATA.results[scnKey()], fi=frameIdx();
  const g=(id,v)=>document.getElementById(id).textContent=v;
  g("ro-speed", R.mean_speed_t[fi].toFixed(0)+" km/h");
  g("ro-occ",   R.seg_rho[fi][DATA.meta.bottleneck_seg]
                ? (100*R.seg_rho[fi][DATA.meta.bottleneck_seg]/DATA.meta.rho_max).toFixed(1)+" %" : "–");
  g("ro-queue", Math.round(R.total_ramp_q[fi])+" veh");
  g("ro-flow",  Math.round(R.flow_out[fi])+" veh/h");
  g("ro-vsl",   vslOn ? R.vsl[fi].toFixed(0)+" km/h" : "off");
  const simSec=frame*DATA.meta.step;
  g("clock", `${String(Math.floor(simSec/60)).padStart(2,"0")}:${String(Math.floor(simSec%60)).padStart(2,"0")}`);
  document.getElementById("timeline").value=100*frame/(R.t.length-1);
}

/* ------------------------------------------------------------ loop */
function loop(ts){
  requestAnimationFrame(loop);
  if(!DATA) return;
  const dt=Math.min(0.05,(ts-lastTS)/1000||0); lastTS=ts;
  if(playing){
    const dFrame=15*rate*dt, n=DATA.results[scnKey()].t.length;
    advanceParticles(dFrame*DATA.meta.step);
    frame+=dFrame;
    if(frame>=n-1){ frame=n-1; togglePlay(false); }
    renderFrame();
  }
}
function togglePlay(on){
  playing=(on===undefined)?!playing:on;
  if(playing && DATA && frame>=DATA.results[scnKey()].t.length-1){ frame=0; resetParticles(); }
  document.getElementById("btn-play").textContent=playing?"❚❚":"▶";
}

/* ------------------------------------------------------------ info modal */
function openInfo(sectionId){
  const m=document.getElementById("info-modal");
  m.classList.remove("hidden");
  // if playback has finished, restart it so the operating point animates
  if(DATA && !playing && frame >= DATA.results[scnKey()].t.length-1){ togglePlay(true); }
  drawFD();
  if(sectionId){
    const el=document.getElementById(sectionId);
    if(el) setTimeout(()=>el.scrollIntoView({behavior:"instant",block:"start"}),0);
    document.querySelectorAll(".modal-nav a").forEach(a=>
      a.classList.toggle("active", a.getAttribute("href")==="#"+sectionId));
  }
}
function closeInfo(){ document.getElementById("info-modal").classList.add("hidden"); }
function initModal(){
  document.querySelectorAll("#info-modal [data-close]").forEach(el=>
    el.addEventListener("click",closeInfo));
  document.addEventListener("keydown",e=>{ if(e.key==="Escape") closeInfo(); });
  // nav links + scrollspy
  const body=document.getElementById("modal-body");
  document.querySelectorAll(".modal-nav a").forEach(a=>
    a.addEventListener("click",e=>{ e.preventDefault();
      const id=a.getAttribute("href").slice(1);
      document.getElementById(id).scrollIntoView({behavior:"smooth",block:"start"});
    }));
  body.addEventListener("scroll",()=>{
    const secs=[...body.querySelectorAll("section")];
    let cur=secs[0].id;
    for(const s of secs){ if(s.offsetTop-body.scrollTop<=90) cur=s.id; }
    document.querySelectorAll(".modal-nav a").forEach(a=>
      a.classList.toggle("active", a.getAttribute("href")==="#"+cur));
  });
}
// Fundamental diagram: flow q = rho * V(rho), V(rho)=v_free*exp(-(1/a)(rho/rc)^a)
function drawFD(){
  const cv=document.getElementById("fd-canvas"); if(!cv) return;
  const {ctx,w,h}=setupCanvas(cv); ctx.clearRect(0,0,w,h);
  const vf=(DATA?DATA.meta.v_free:110), rc=(DATA?DATA.meta.rho_crit:33.5),
        a=(DATA?DATA.meta.a_fd:1.867), rmax=(DATA?DATA.meta.rho_max:180);
  const pad={l:44,r:12,t:14,b:26}, iw=w-pad.l-pad.r, ih=h-pad.t-pad.b;
  const V=r=>vf*Math.exp(-(1/a)*Math.pow(r/rc,a));
  const qmax=rc*V(rc)*1.15;
  const X=r=>pad.l+iw*r/rmax, Y=q=>pad.t+ih*(1-q/qmax);
  // axes
  ctx.strokeStyle="#26303f"; ctx.lineWidth=1; ctx.font=MONO; ctx.fillStyle="#5c6a7e";
  ctx.beginPath();ctx.moveTo(pad.l,pad.t);ctx.lineTo(pad.l,pad.t+ih);ctx.lineTo(pad.l+iw,pad.t+ih);ctx.stroke();
  ctx.fillText("flow", 6, pad.t+8); ctx.textAlign="right"; ctx.fillText("density →", pad.l+iw, h-6); ctx.textAlign="left";
  // free-flow / congested shading split at rc
  ctx.fillStyle="rgba(84,214,160,.10)"; ctx.fillRect(pad.l,pad.t,X(rc)-pad.l,ih);
  ctx.fillStyle="rgba(242,96,122,.10)"; ctx.fillRect(X(rc),pad.t,pad.l+iw-X(rc),ih);
  // curve
  ctx.strokeStyle="#5cc8ff"; ctx.lineWidth=2; ctx.beginPath();
  for(let r=0;r<=rmax;r+=1){ const x=X(r),y=Y(r*V(r)); r?ctx.lineTo(x,y):ctx.moveTo(x,y); }
  ctx.stroke();
  // critical point
  const cx=X(rc), cy=Y(rc*V(rc));
  ctx.setLineDash([3,3]); ctx.strokeStyle="#f3c14a";
  ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx,pad.t+ih);ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle="#f3c14a"; ctx.beginPath();ctx.arc(cx,cy,4.5,0,7);ctx.fill();
  ctx.textAlign="right"; ctx.fillText("capacity", cx-9, cy-4);
  ctx.textAlign="left";  ctx.fillText("ô target", cx+10, cy-4);
  ctx.fillStyle="#54d6a0"; ctx.textAlign="left"; ctx.fillText("free-flow", pad.l+8, pad.t+ih-8);
  ctx.fillStyle="#f2607a"; ctx.textAlign="right"; ctx.fillText("congested", pad.l+iw-6, pad.t+ih-8); ctx.textAlign="left";

  // --- live operating point: bottleneck segment, current frame & scenario ---
  if(DATA){
    const R=DATA.results[scnKey()], bs=DATA.meta.bottleneck_seg, fi=frameIdx();
    const col=COLORS[control]||"#5cc8ff";
    const px=r=>Math.max(pad.l,Math.min(pad.l+iw,X(r)));
    const py=q=>Math.max(pad.t,Math.min(pad.t+ih,Y(q)));
    // The dot rides the equilibrium curve at the live density, so it always
    // reads as a point ON the fundamental diagram (dynamic speed overshoots
    // would otherwise float it above capacity during transitions).
    // fading trail over the last ~30 frames (≈5 min of model time)
    for(let i=Math.max(0,fi-30);i<fi;i++){
      const rho=R.seg_rho[i][bs];
      ctx.globalAlpha=Math.max(0,0.05+0.45*(i-(fi-30))/30);
      ctx.fillStyle=col; ctx.beginPath(); ctx.arc(px(rho),py(rho*V(rho)),1.8,0,7); ctx.fill();
    }
    ctx.globalAlpha=1;
    // current state
    const rho=R.seg_rho[fi][bs], v=R.seg_v[fi][bs];
    const x=px(rho), y=py(rho*V(rho));
    ctx.setLineDash([2,3]); ctx.strokeStyle="rgba(232,237,245,.25)"; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(x,pad.t+ih); ctx.lineTo(x,y); ctx.lineTo(pad.l,y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowColor=col; ctx.shadowBlur=11;
    ctx.fillStyle=col; ctx.beginPath(); ctx.arc(x,y,6,0,7); ctx.fill();
    ctx.shadowBlur=0;
    ctx.fillStyle="#0b0f16"; ctx.beginPath(); ctx.arc(x,y,3.3,0,7); ctx.fill();
    ctx.fillStyle="#fff"; ctx.beginPath(); ctx.arc(x,y,1.6,0,7); ctx.fill();
    // live readout, top-left of the plot
    ctx.fillStyle=col; ctx.font=MONO; ctx.textAlign="left";
    const side = rho>rc ? "congested" : "free-flow";
    ctx.fillText("now · ρ "+rho.toFixed(0)+" veh/km · "+v.toFixed(0)+" km/h · "+side, pad.l+8, pad.t+12);
  }
}

/* ------------------------------------------------------------ CSV upload */
function currentRampNames(){
  return DATA ? DATA.meta.on_ramps.map(o=>o.name) : [];
}
function setDataStatus(msg, active){
  const s=document.getElementById("data-status");
  s.textContent=msg; s.classList.toggle("active",!!active);
  document.getElementById("csv-clear").classList.toggle("hidden",!active);
}
function initDataUpload(){
  document.getElementById("csv-file").addEventListener("change",e=>{
    const f=e.target.files[0]; if(!f) return;
    const rd=new FileReader();
    rd.onload=()=>{ try{ applyCSV(rd.result, f.name); }catch(err){ setDataStatus("⚠ "+err.message,false); demandProfile=null; } };
    rd.readAsText(f);
    e.target.value="";  // allow re-uploading same file
  });
  document.getElementById("csv-template").addEventListener("click",downloadTemplate);
  document.getElementById("csv-clear").addEventListener("click",()=>{
    demandProfile=null; setDataStatus("Using the built-in AM-peak profile.",false); run();
  });
}
function parseCSV(text){
  const rows=text.replace(/\r/g,"").split("\n").map(r=>r.trim()).filter(r=>r.length);
  if(rows.length<2) throw new Error("need a header row + at least one data row");
  const head=rows[0].split(",").map(s=>s.trim());
  const data=rows.slice(1).map(r=>r.split(",").map(s=>parseFloat(s.trim())));
  return {head, data};
}
function applyCSV(text, name){
  const {head, data}=parseCSV(text);
  const lc=head.map(h=>h.toLowerCase());
  const ti=lc.findIndex(h=>h.startsWith("time"));
  const mi=lc.findIndex(h=>h==="mainline"||h==="main");
  if(ti<0) throw new Error("no 'time_min' column");
  if(mi<0) throw new Error("no 'mainline' column");
  const names=currentRampNames();
  // match each ramp name to a column (case/space-insensitive), else zero series
  const norm=s=>s.toLowerCase().replace(/[^a-z0-9]/g,"");
  const colFor=names.map(nm=>{ const k=norm(nm);
    return head.findIndex(h=>norm(h)===k); });
  const time_s=[], mainline=[], ramps=names.map(()=>[]);
  for(const row of data){
    if(row.length<2 || isNaN(row[ti])) continue;
    time_s.push(row[ti]*60);
    mainline.push(isNaN(row[mi])?0:row[mi]);
    names.forEach((nm,j)=>{ const c=colFor[j]; ramps[j].push(c>=0&&!isNaN(row[c])?row[c]:0); });
  }
  if(time_s.length<2) throw new Error("need at least two valid rows");
  demandProfile={time_s, mainline, ramps};
  const matched=colFor.filter(c=>c>=0).length;
  setDataStatus(`✓ ${name}: ${time_s.length} rows · ${matched}/${names.length} ramps matched.`, true);
  run();
}
function downloadTemplate(){
  if(!DATA){ return; }
  const names=currentRampNames();
  const H=DATA.meta.horizon, step=5; // minutes
  const rows=[["time_min","mainline",...names].join(",")];
  // seed with the corridor's built-in synthetic demand as a starting point
  for(let mmin=0; mmin<=Math.round(H/60); mmin+=step){
    const t=mmin*60, ds=demandScale(t);
    const main=Math.round(DATA.meta.mainline_demand*ds);
    const rd=names.map((nm,j)=>{
      const r=DATA.meta.ramps.find(r=>r.kind==="on"&&r.name===nm);
      return Math.round((r?r.demand:600)*ds);
    });
    rows.push([mmin,main,...rd].join(","));
  }
  const blob=new Blob([rows.join("\n")],{type:"text/csv"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url; a.download=`${DATA.meta.id}_demand_template.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

/* ------------------------------------------------------------ wiring */
function initControls(){
  document.getElementById("btn-play").addEventListener("click",()=>togglePlay());
  document.getElementById("btn-info").addEventListener("click",()=>openInfo());
  document.getElementById("open-data-help").addEventListener("click",e=>{ e.preventDefault(); openInfo("sec-data"); });
  initModal();
  initDataUpload();
  document.getElementById("timeline").addEventListener("input",e=>{
    if(!DATA)return; const n=DATA.results[scnKey()].t.length;
    frame=(e.target.value/100)*(n-1); resetParticles(); renderFrame();
  });
  document.querySelectorAll("#scenario-tabs button").forEach(b=>
    b.addEventListener("click",()=>{ control=b.dataset.scn;
      document.querySelectorAll("#scenario-tabs button").forEach(x=>x.classList.remove("active"));
      b.classList.add("active"); resetParticles(); refreshAll(); }));
  document.querySelectorAll("#view-toggle button").forEach(b=>
    b.addEventListener("click",()=>{ view=b.dataset.view;
      document.querySelectorAll("#view-toggle button").forEach(x=>x.classList.remove("active"));
      b.classList.add("active");
      document.getElementById("view-schematic").classList.toggle("hidden",view!=="schematic");
      document.getElementById("view-map").classList.toggle("hidden",view!=="map");
      if(view==="map" && map){ setTimeout(()=>{
        map.invalidateSize();
        if(lineBounds) map.fitBounds(lineBounds,{padding:[30,30]});
        updateMap();
      },120); }
      renderFrame();
    }));
  document.querySelectorAll(".speed-select button").forEach(b=>
    b.addEventListener("click",()=>{ rate=parseFloat(b.dataset.rate);
      document.querySelectorAll(".speed-select button").forEach(x=>x.classList.remove("active"));
      b.classList.add("active"); }));
  window.addEventListener("resize",()=>{ if(DATA) renderFrame(); });
}

initCorridors();
initSliders();
initControls();
requestAnimationFrame(loop);
run();
