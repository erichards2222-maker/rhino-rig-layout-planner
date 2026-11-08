'use strict';
const EMBED_IMAGE = null;
const EMBED_META = {};
const $=id=>document.getElementById(id),canvas=$('imageCanvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});
const st={img:null,w:0,h:0,base:null,mask:null,maskArea:0,bbox:null,cal:[],poly:[],mode:'idle',source:{},result:null,scenario:'edge',seed:null,exclusions:[],baseMask:null,legacyMask:false,selectedExclusion:null,draft:[],workBudget:3500000};
const TWO_PI=2*Math.PI;let locked=false;
let rigChanged=()=>{},rigImageInstalled=()=>{};
function status(message,kind=''){const e=$('status');e.textContent=message;e.className='status'+(kind?' '+kind:'');}
function setEnabled(ok){for(const id of ['auto','seed','polygon','calibrate','resetScale'])$(id).disabled=!ok;updateButtons();}
function updateButtons(){const ready=!!st.img;
 for(const id of ['plan'])$(id).disabled=!ready||!st.mask||!st.bbox||!metersPerPixel();
 for(const id of ['exclude','excludePolygon','excludeFreehand','editExclusions','resetBoundary','resetAnalysis']){const e=$(id);if(e)e.disabled=!ready;}
 $('undo').disabled=!ready||!(st.draft.length||st.poly.length&&st.mode==='poly'||Editor.canUndo());
 if($('redo'))$('redo').disabled=!ready||!Editor.canRedo();
 $('finish').disabled=!ready||!['poly','exclude-poly','freehand'].includes(st.mode)||st.draft.length<3;
 if($('cancelDrawing'))$('cancelDrawing').disabled=!ready||!['poly','exclude-poly','freehand','cal'].includes(st.mode);
 if($('deleteExclusion'))$('deleteExclusion').disabled=!st.selectedExclusion;
 if($('clearExclusions'))$('clearExclusions').disabled=!st.exclusions.length;
 $('clearResult').disabled=!st.result;for(const id of ['toggleMargin','savePng','saveCsv','saveJson','printLayout'])$(id).disabled=!st.result;
 if($('legacyGeometryNotice')){$('legacyGeometryNotice').hidden=!st.legacyMask;$('legacyGeometryNotice').textContent='Older effective mask retained. Its existing holes cannot be restored by deleting old exclusions. Re-detect or retrace the boundary on this verified image to establish a new editable base.';}
}
function invalidNumber(id,min,max){const n=Number($(id).value);return !Number.isFinite(n)||n<min||n>max?null:n}
function metersPerPixel(){if(st.cal.length!==2)return null;const length=invalidNumber('referenceMeters',1,50);if(length===null)return null;const p=Math.hypot(st.cal[1].x-st.cal[0].x,st.cal[1].y-st.cal[0].y);if(p<8)return null;const mpp=length/p;return mpp>=0.005&&mpp<=10?mpp:null;}
function setCalibrationLabels(){const p=st.cal.length===2?Math.hypot(st.cal[1].x-st.cal[0].x,st.cal[1].y-st.cal[0].y):null;const mpp=metersPerPixel();$('pixelsLabel').textContent=p!==null?p.toFixed(1):'—';$('scaleLabel').textContent=mpp!==null?mpp.toFixed(4):'—';updateButtons()}
function getXY(e){const rect=canvas.getBoundingClientRect();return{x:(e.clientX-rect.left)*st.w/rect.width,y:(e.clientY-rect.top)*st.h/rect.height};}
let rigEpoch=0;
function resetResults(){rigChanged();rigEpoch++;st.result=null;st.scenario='edge';$('safeCount').textContent='—';$('edgeCount').textContent='—';$('searchSummary').textContent='No layout calculated.';$('rigRows').replaceChildren();$('toggleMargin').textContent='CONSERVATIVE — optional comparison';renderSelection();updateButtons();}
function installImage(img,meta){const MAX_SIDE=2048;const scale=Math.min(1,MAX_SIDE/Math.max(img.naturalWidth,img.naturalHeight));st.w=meta?.workingWidth||Math.max(1,Math.round(img.naturalWidth*scale));st.h=meta?.workingHeight||Math.max(1,Math.round(img.naturalHeight*scale));
 if(st.w*st.h>4500000)throw new Error('Image exceeds planner pixel bound');canvas.width=st.w;canvas.height=st.h;ctx.drawImage(img,0,0,st.w,st.h);
 st.img=img;st.base=document.createElement('canvas');st.base.width=st.w;st.base.height=st.h;st.base.getContext('2d',{willReadFrequently:true}).drawImage(img,0,0,st.w,st.h);
 st.mask=null;st.baseMask=null;st.legacyMask=false;st.bbox=null;st.maskArea=0;st.cal=[];st.poly=[];st.draft=[];st.mode='idle';st.seed=null;st.exclusions=[];st.selectedExclusion=null;Editor.clearHistory();st.source=meta||{};resetResults();setEnabled(true);setCalibrationLabels();$('sourceTag').textContent=(meta?.source_file_name||'Selected local image')+' · '+st.w+'×'+st.h;
 status('Image loaded. Detect purple, inspect the mask, then calibrate with two clicks on the Rhino.');$('restoreRig').hidden=true;draw();rigImageInstalled();}
function kind(bytes){if(bytes.length>=8&&bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71)return'image/png';if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return'image/jpeg';if(bytes[0]===66&&bytes[1]===77)return'image/bmp';if(bytes.length>=12&&String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP')return'image/webp';return null;}
$('cancelRig').addEventListener('click',()=>{resetResults();status('Layout search canceled.');draw();});
function largestComponent(bits,seed=null){
 if(seed!==null&&!bits[seed])return null;
 const N=st.w*st.h,visited=new Uint8Array(N),queue=new Int32Array(N);let max=0,best=[],bestbox=null,area=0;
 function grow(start){let head=0,tail=0;queue[tail++]=start;visited[start]=1;let minx=st.w,miny=st.h,maxx=0,maxy=0;
 while(head<tail){const k=queue[head++],x=k%st.w,y=Math.floor(k/st.w);if(x<minx)minx=x;if(y<miny)miny=y;if(x>maxx)maxx=x;if(y>maxy)maxy=y;
 for(const n of [x>0?k-1:-1,x+1<st.w?k+1:-1,y>0?k-st.w:-1,y+1<st.h?k+st.w:-1])if(n>=0&&bits[n]&&!visited[n]){visited[n]=1;queue[tail++]=n;}}
 return {size:tail,items:queue.slice(0,tail),box:{minx,miny,maxx,maxy}};}
 if(seed!==null){const c=grow(seed);best=c.items;bestbox=c.box;max=c.size;}
 else for(let i=0;i<N;i++)if(bits[i]&&!visited[i]){const c=grow(i);if(c.size>max){max=c.size;best=c.items;bestbox=c.box;}}
 if(max<300)return null;const out=new Uint8Array(N);for(const k of best)out[k]=1;return {mask:out,bbox:bestbox,area:max};}
function detectPurple(seed){if(!st.base)return;Editor.checkpoint();resetResults();const w=st.w,h=st.h,data=st.base.getContext('2d',{willReadFrequently:true}).getImageData(0,0,w,h).data,threshold=Number($('threshold').value);const bits=new Uint8Array(w*h);
 for(let i=0,p=0;i<bits.length;i++,p+=4){const r=data[p],g=data[p+1],b=data[p+2];bits[i]=(r>55&&b>50&&r-g>threshold&&b-g>threshold&&Math.abs(r-b)<85)?1:0;}
 let seedIndex=null;
 if(seed){
  const x=Math.floor(seed.x),y=Math.floor(seed.y);
  seedIndex=x>=0&&x<w&&y>=0&&y<h?y*w+x:-1;
 }
 const obj=largestComponent(bits,seedIndex);
 if(!obj){
  st.mask=null;st.baseMask=null;st.legacyMask=false;st.poly=[];st.bbox=null;st.maskArea=0;
  let message='No single connected purple region found. Try a smaller sensitivity value, or draw the boundary manually.';
  if(seedIndex!==null){
   st.mode='seed';
   message=bits[seedIndex]?'This purple region is too small. Click a larger region or draw the boundary manually.'
                          :'That pixel is outside the classified purple region. Click inside the desired region or draw the boundary manually.';
  }
  status(message,'warn');draw();updateButtons();return;
 }
 st.baseMask=obj.mask;st.legacyMask=false;st.mode='idle';st.poly=[];st.draft=[];Editor.rebuild();draw();updateButtons();status('Detected one connected purple region ('+obj.area.toLocaleString()+' pixels). Inspect its outline. Correct it manually if any portions are missing.');}
function applyMask(m){let minx=st.w,miny=st.h,maxx=0,maxy=0,count=0;for(let y=0;y<st.h;y++)for(let x=0;x<st.w;x++){if(m[y*st.w+x]){count++;if(x<minx)minx=x;if(x>maxx)maxx=x;if(y<miny)miny=y;if(y>maxy)maxy=y;}}st.mask=m;st.maskArea=count;st.bbox=count?{minx,miny,maxx,maxy}:null;resetResults();draw();updateButtons();}
function usePolygon(){return Editor.finish();}
function draw(){if(!st.base)return;ctx.clearRect(0,0,st.w,st.h);ctx.drawImage(st.base,0,0);if(st.mask){const overlay=document.createElement('canvas');overlay.width=st.w;overlay.height=st.h;const oc=overlay.getContext('2d'),im=oc.createImageData(st.w,st.h);for(let i=0;i<st.mask.length;i++)if(st.mask[i]){const n=4*i;im.data[n]=38;im.data[n+1]=210;im.data[n+2]=159;im.data[n+3]=48;}oc.putImageData(im,0,0);ctx.drawImage(overlay,0,0);}
 if(st.exclusions.length){for(const p of st.exclusions){const selected=p.id===st.selectedExclusion;ctx.strokeStyle=selected?'#fff2a8':'#ff8b82';ctx.fillStyle='#e45b5b33';ctx.lineWidth=selected?3:2;ctx.beginPath();if(p.type==='polygon'){ctx.moveTo(p.points[0].x,p.points[0].y);for(const v of p.points.slice(1))ctx.lineTo(v.x,v.y);ctx.closePath();}else ctx.arc(p.x,p.y,p.radius,0,TWO_PI);ctx.fill();ctx.stroke();if(selected){const handles=p.type==='polygon'?p.points:[{x:p.x,y:p.y},{x:p.x+p.radius,y:p.y}];ctx.fillStyle='#fff';for(const v of handles){ctx.beginPath();ctx.arc(v.x,v.y,4,0,TWO_PI);ctx.fill();}}}}
 if(st.cal.length){ctx.lineWidth=Math.max(2,st.w/650);ctx.strokeStyle='#ffdb70';ctx.fillStyle='#ffdb70';for(const p of st.cal){ctx.beginPath();ctx.arc(p.x,p.y,6,0,TWO_PI);ctx.fill();}if(st.cal.length===2){ctx.beginPath();ctx.moveTo(st.cal[0].x,st.cal[0].y);ctx.lineTo(st.cal[1].x,st.cal[1].y);ctx.stroke();}}
 if(st.draft.length){ctx.strokeStyle=st.mode==='poly'?'#fcdf6c':'#ff8b82';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(st.draft[0].x,st.draft[0].y);for(const p of st.draft.slice(1))ctx.lineTo(p.x,p.y);if(st.draft.length>2){ctx.lineTo(st.draft[0].x,st.draft[0].y);}ctx.stroke();for(const p of st.draft){ctx.fillStyle='#fcdf6c';ctx.beginPath();ctx.arc(p.x,p.y,4,0,TWO_PI);ctx.fill();}}
 if(st.result){const s=st.scenario==='safe'?st.result.safe:st.result.edge;ctx.lineWidth=3;for(const p of s.points){ctx.beginPath();ctx.arc(p.x,p.y,Math.max(9,st.w/140),0,TWO_PI);ctx.fillStyle='#0e6f58';ctx.strokeStyle='#fff';ctx.fill();ctx.stroke();ctx.font=`bold ${Math.max(12,st.w/95)}px Arial`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle='white';ctx.fillText(String(p.n),p.x,p.y);}}}
// A canvas pixel covers [column,column+1] × [row,row+1]. Cache counts of
// excluded pixels so a disk query can skip whole empty rectangles at once.
const exclusionIndices = new WeakMap();
function exclusionIndex() {
 const prior = exclusionIndices.get(st.mask);
 if (prior && prior.stride === st.w + 1) return prior;
 const stride = st.w + 1, sums = new Uint32Array(stride * (st.h + 1));
 for (let y = 0; y < st.h; y++) {
  let row = 0;
  for (let x = 0; x < st.w; x++) {
   if (!st.mask[y * st.w + x]) row++;
   sums[(y+1)*stride+x+1] = sums[y*stride+x+1] + row;
  }
 }
 const index = {sums, stride};
 exclusionIndices.set(st.mask, index);
 return index;
}
function diskHitsExcluded(index, x, y, radiusSquared, left, top, right, bottom) {
 const dx = Math.max(left - x, 0, x - right), dy = Math.max(top - y, 0, y - bottom);
 if (dx*dx + dy*dy >= radiusSquared) return false;
 const {sums, stride} = index;
 const count = sums[bottom*stride+right] - sums[top*stride+right]
             - sums[bottom*stride+left] + sums[top*stride+left];
 if (!count) return false;
 const width = right - left, height = bottom - top;
 if (count === width * height) return true;
 // Any excluded cell in a rectangle wholly contained in the disk is a hit.
 const farX = Math.max(x - left, right - x), farY = Math.max(y - top, bottom - y);
 if (farX*farX + farY*farY <= radiusSquared) return true;
 if (width >= height) {
  const mid = left + Math.floor(width / 2);
  return diskHitsExcluded(index, x, y, radiusSquared, left, top, mid, bottom) ||
         diskHitsExcluded(index, x, y, radiusSquared, mid, top, right, bottom);
 }
 const mid = top + Math.floor(height / 2);
 return diskHitsExcluded(index, x, y, radiusSquared, left, top, right, mid) ||
        diskHitsExcluded(index, x, y, radiusSquared, left, mid, right, bottom);
}
function insetCheck(x, y, marginPx) {
 const ix = Math.floor(x), iy = Math.floor(y);
 if (ix < 0 || iy < 0 || ix >= st.w || iy >= st.h || !st.mask?.[iy*st.w+ix]) return false;
 if (Math.min(x, y, st.w-x, st.h-y) < marginPx) return false;
 for (const shape of st.exclusions) {
  if(shape.type==='polygon'){
   if(Editor.contains(shape.points,{x,y}))return false;
   if(marginPx>0&&Editor.polygonDistance(shape.points,{x,y})<marginPx)return false;
  }else{
   const dx=x-shape.x,dy=y-shape.y,distanceSquared=dx*dx+dy*dy,clearance=shape.radius+marginPx;
   if(marginPx===0?distanceSquared<=clearance*clearance:distanceSquared<clearance*clearance)return false;
  }
 }
 if (marginPx <= 0) return true;
 return !diskHitsExcluded(exclusionIndex(), x, y, marginPx*marginPx,
                          Math.floor(x-marginPx), Math.floor(y-marginPx),
                          Math.ceil(x+marginPx), Math.ceil(y+marginPx));
}
function excludeCircle(center,radius){return Editor.addCircle(center,radius);}
const Editor=(()=>{
 const MAX_SHAPES=128,MAX_VERTICES=512,HISTORY_BYTES=24*1024*1024,HISTORY_COUNT=32,FREEHAND_TOLERANCE=1.5;
 let past=[],future=[],historyBytes=0,sequence=0,drag=null,draftBefore=null,suppressClick=false;
 const copy=o=>JSON.parse(JSON.stringify(o));
 const point=p=>!!p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=-4096&&p.y>=-4096&&p.x<=6144&&p.y<=6144;
 function segmentDistance(p,a,b){const dx=b.x-a.x,dy=b.y-a.y,n=dx*dx+dy*dy,t=n?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/n)):0;return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);}
 function contains(points,p){let inside=false;for(let i=0,j=points.length-1;i<points.length;j=i++){const a=points[j],b=points[i];if(segmentDistance(p,a,b)<=1e-9)return true;if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)inside=!inside;}return inside;}
 function polygonDistance(points,p){let d=Infinity;for(let i=0;i<points.length;i++)d=Math.min(d,segmentDistance(p,points[i],points[(i+1)%points.length]));return d;}
 function cross(a,b,c){return (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);}
 function intersects(a,b,c,d){const x=cross(a,b,c),y=cross(a,b,d),z=cross(c,d,a),w=cross(c,d,b);if(((x>1e-9&&y< -1e-9)||(x< -1e-9&&y>1e-9))&&((z>1e-9&&w< -1e-9)||(z< -1e-9&&w>1e-9)))return true;return Math.abs(x)<=1e-9&&segmentDistance(c,a,b)<=1e-9||Math.abs(y)<=1e-9&&segmentDistance(d,a,b)<=1e-9||Math.abs(z)<=1e-9&&segmentDistance(a,c,d)<=1e-9||Math.abs(w)<=1e-9&&segmentDistance(b,c,d)<=1e-9;}
 function validatePolygon(points){if(!Array.isArray(points)||points.length<3||points.length>MAX_VERTICES||points.some(p=>!point(p)))throw Error('Use 3–512 finite vertices within the supported image workspace.');let area=0;for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length];if(Math.hypot(a.x-b.x,a.y-b.y)<1e-6)throw Error('Outline has duplicate adjacent vertices. Move or remove a vertex.');const c=points[(i+2)%points.length];if(Math.abs(cross(a,b,c))<=1e-9&&(b.x-a.x)*(c.x-b.x)+(b.y-a.y)*(c.y-b.y)<0)throw Error('Outline backtracks along an edge. Remove the redundant vertex.');area+=a.x*b.y-b.x*a.y;for(let j=i+1;j<points.length;j++){if(j===i+1||i===0&&j===points.length-1)continue;if(intersects(a,b,points[j],points[(j+1)%points.length]))throw Error('Outline crosses or touches itself. Move/remove vertices before finishing.');}}if(Math.abs(area)<1e-6)throw Error('Outline has no enclosed area.');return true;}
 function validateShape(s){if(!s||typeof s!=='object'||!/^ex-[A-Za-z0-9-]{1,60}$/.test(s.id||''))throw Error('Invalid exclusion identity.');if(s.type==='polygon'){if(!['polygon','freehand'].includes(s.kind))throw Error('Invalid outline type.');validatePolygon(s.points);if(s.kind==='freehand'&&(!Number.isFinite(s.tolerancePx)||s.tolerancePx<0||s.tolerancePx>8))throw Error('Invalid outline tolerance.');}else if(s.type==='circle'){if(!point(s)||!Number.isFinite(s.radius)||s.radius<=0||s.radius>20000)throw Error('Invalid circle geometry.');}else throw Error('Unsupported exclusion shape.');return true;}
 function id(){let n;do{n='ex-'+(++sequence);}while(st.exclusions.some(s=>s.id===n));return n;}
 function capture(){const values={};for(const key of ['referenceMeters','spacingMeters','marginMeters','exclusionMeters','threshold'])values[key]=$(key).value;values.fine=$('fine').checked;return {baseMask:st.baseMask?.slice()||st.mask?.slice()||null,legacyMask:!!st.legacyMask,cal:copy(st.cal),poly:copy(st.poly),exclusions:copy(st.exclusions),selected:st.selectedExclusion,result:st.result?copy(st.result):null,scenario:st.scenario,values};}
 function cost(s){return (s.baseMask?.byteLength||0)+JSON.stringify({...s,baseMask:null}).length*2;}
 function trim(){historyBytes=past.reduce((n,s)=>n+cost(s),0);while(past.length>HISTORY_COUNT||historyBytes>HISTORY_BYTES){historyBytes-=cost(past.shift());}}
 function checkpoint(snapshot=null){past.push(snapshot||capture());future=[];trim();}
 function clearHistory(){past=[];future=[];historyBytes=0;drag=null;draftBefore=null;st.draft=[];}
 function showResult(){if(st.result){$('safeCount').textContent=st.result.safe.points.length;$('edgeCount').textContent=st.result.edge.points.length;$('searchSummary').textContent='Restored calculation snapshot; '+(st.result.safe.complete&&st.result.edge.complete?'finite search completed.':'partial search.');}renderSelection();renderTable();setCalibrationLabels();describeSelection();draw();updateButtons();}
 function restore(s){rigEpoch++;st.baseMask=s.baseMask?.slice()||null;st.legacyMask=s.legacyMask;st.cal=copy(s.cal);st.poly=copy(s.poly);st.exclusions=copy(s.exclusions);st.selectedExclusion=s.selected;st.mode='idle';st.draft=[];draftBefore=null;for(const [k,v] of Object.entries(s.values||{})){if(k==='fine')$(k).checked=v;else $(k).value=v;}rebuild();st.result=s.result?copy(s.result):null;st.scenario=s.scenario;rigChanged();showResult();}
 function undo(){if(drag){cancelDrag();return;}if(st.draft.length){st.draft.pop();rigChanged();draw();updateButtons();status('Removed the latest draft vertex.');return;}if(draftBefore){cancel();return;}if(!past.length)return;const s=past.pop();future.push(capture());restore(s);trim();status('Undid the last analysis operation.');}
 function redo(){if(drag){cancelDrag();return;}if(st.draft.length||draftBefore||!future.length)return;past.push(capture());const s=future.pop();trim();restore(s);status('Redid the analysis operation.');}
 function shapeContains(s,p){return s.type==='polygon'?contains(s.points,p):Math.hypot(p.x-s.x,p.y-s.y)<=s.radius;}
 function effectiveMask(base,width,height,shapes){const mask=base.slice();let work=0;for(const s of shapes){const points=s.type==='polygon'?s.points:[{x:s.x-s.radius,y:s.y-s.radius},{x:s.x+s.radius,y:s.y+s.radius}];const left=Math.max(0,Math.floor(Math.min(...points.map(p=>p.x)))),right=Math.min(width-1,Math.ceil(Math.max(...points.map(p=>p.x)))),top=Math.max(0,Math.floor(Math.min(...points.map(p=>p.y)))),bottom=Math.min(height-1,Math.ceil(Math.max(...points.map(p=>p.y))));work+=Math.max(0,right-left+1)*Math.max(0,bottom-top+1)*(s.type==='polygon'?s.points.length:1);if(work>50000000)throw Error('Exclusion raster work limit reached. Simplify large outlines or reduce exclusion count.');for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++)if(mask[y*width+x]&&shapeContains(s,{x:x+.5,y:y+.5}))mask[y*width+x]=0;}return mask;}
 function rebuild(){if(!st.baseMask){st.mask=null;st.bbox=null;st.maskArea=0;resetResults();draw();updateButtons();return;}applyMask(effectiveMask(st.baseMask,st.w,st.h,st.exclusions));}
 function ensureBase(){if(!st.baseMask&&st.mask)st.baseMask=st.mask.slice();}
 function addCircle(center,radius){if(st.exclusions.length>=MAX_SHAPES)throw Error('This image already has 128 exclusions.');const s={id:id(),type:'circle',x:center.x,y:center.y,radius};validateShape(s);ensureBase();if(st.baseMask)effectiveMask(st.baseMask,st.w,st.h,[...st.exclusions,s]);checkpoint();st.exclusions.push(s);st.selectedExclusion=s.id;rebuild();describeSelection();return s.id;}
 function addPolygon(points,kind='polygon',tolerancePx=FREEHAND_TOLERANCE){if(st.exclusions.length>=MAX_SHAPES)throw Error('This image already has 128 exclusions.');const s={id:id(),type:'polygon',kind,points:copy(points)};if(kind==='freehand')s.tolerancePx=tolerancePx;validateShape(s);ensureBase();if(st.baseMask)effectiveMask(st.baseMask,st.w,st.h,[...st.exclusions,s]);checkpoint();st.exclusions.push(s);st.selectedExclusion=s.id;rebuild();describeSelection();return s.id;}
 function select(value){st.selectedExclusion=st.exclusions.some(s=>s.id===value)?value:null;describeSelection();draw();updateButtons();}
 function selected(){return st.exclusions.find(s=>s.id===st.selectedExclusion);}
 function describeSelection(){const s=selected(),mpp=metersPerPixel();if($('exclusionSelection'))$('exclusionSelection').textContent=s?'Selected '+s.id+' — '+(s.type==='circle'?'circle':s.kind+' outline'):'No exclusion selected';if($('exclusionRadiusLabel'))$('exclusionRadiusLabel').textContent=(s?.type==='circle'?'Selected circle radius':'Next circle radius')+(mpp?' (m)':' (image pixels; uncalibrated)');if($('circleRadius')){$('circleRadius').disabled=s?.type!=='circle';if(s?.type==='circle')$('circleRadius').value=String(Number((s.radius*(mpp||1)).toFixed(6)));}}
 function alter(value,fn){const index=st.exclusions.findIndex(s=>s.id===value);if(index<0)throw Error('Select an exclusion first.');const candidate=copy(st.exclusions[index]);fn(candidate);validateShape(candidate);if(st.baseMask)effectiveMask(st.baseMask,st.w,st.h,st.exclusions.map(s=>s.id===value?candidate:s));checkpoint();st.exclusions[index]=candidate;st.selectedExclusion=value;rebuild();describeSelection();}
 function moveShape(value,dx,dy){if(!Number.isFinite(dx)||!Number.isFinite(dy))throw Error('Invalid movement.');alter(value,s=>{if(s.type==='circle'){s.x+=dx;s.y+=dy;}else for(const p of s.points){p.x+=dx;p.y+=dy;}});}
 function moveVertex(value,index,p){alter(value,s=>{if(s.type!=='polygon'||!Number.isInteger(index)||index<0||index>=s.points.length)throw Error('Invalid vertex.');s.points[index]={x:p.x,y:p.y};});}
 function resizeCircle(value,radius){alter(value,s=>{if(s.type!=='circle')throw Error('Select a circle.');s.radius=radius;});}
 function setSelectedRadius(){const s=selected();if(s?.type!=='circle')return;const n=Number(($('circleRadius')||$('exclusionMeters')).value);try{resizeCircle(s.id,n/(metersPerPixel()||1));}catch(e){describeSelection();status(e.message,'warn');}}
 function deleteSelected(){if(!selected())return;checkpoint();st.exclusions=st.exclusions.filter(s=>s.id!==st.selectedExclusion);st.selectedExclusion=null;rebuild();describeSelection();status(st.legacyMask?'Exclusion object removed. Older mask holes remain until the boundary is rebuilt.':'Selected exclusion removed; usable pixels restored from the base boundary.');}
 function clearExclusions(){if(!st.exclusions.length)return;checkpoint();st.exclusions=[];st.selectedExclusion=null;rebuild();describeSelection();status(st.legacyMask?'Exclusion objects cleared. Older mask holes remain until the boundary is rebuilt.':'Exclusions cleared; base boundary and calibration retained.');}
 function resetBoundary(){checkpoint();st.baseMask=null;st.legacyMask=false;st.mask=null;st.poly=[];st.draft=[];st.mode='idle';draftBefore=null;rebuild();status('Boundary reset. Screenshot, exclusions and calibration retained. Detect or trace a new boundary.');}
 function resetCalibration(){checkpoint();st.cal=[];st.mode='idle';st.draft=[];draftBefore=null;resetResults();setCalibrationLabels();describeSelection();draw();status('Calibration reset. Pixel boundary and exclusions retained.');}
 function clearLayout(){checkpoint();resetResults();draw();status('Candidate layout cleared. Geometry and calibration retained.');}
 function resetAnalysis(){rigEpoch++;st.baseMask=null;st.mask=null;st.legacyMask=false;st.bbox=null;st.maskArea=0;st.exclusions=[];st.selectedExclusion=null;st.cal=[];st.poly=[];st.draft=[];st.mode='idle';st.seed=null;if($('analysisNotes'))$('analysisNotes').value='';clearHistory();resetResults();setCalibrationLabels();describeSelection();draw();status('Image analysis reset. Screenshot and numeric preferences retained; choose detection or tracing when ready.');}
 function begin(mode){cancel();st.mode=mode;st.draft=[];draftBefore=mode==='cal'?capture():null;if(mode==='cal'){st.cal=[];resetResults();setCalibrationLabels();}if(mode==='poly'||mode==='exclude-poly')status((mode==='poly'?'Deposit boundary':'Exclusion outline')+': click vertices, then the start handle or Finish/Enter. Escape cancels this draft; Backspace removes its last vertex.');else if(mode==='freehand')status('Draw a closed exclusion. Release, inspect, then Finish. Simplification tolerance is 1.5 image pixels; invalid outlines remain editable drafts.');else if(mode==='cal')status('Click one Rhino end, then the opposite end. Escape restores the previous calibration.');else if(mode==='circle')status('Click an obstruction center. Radius is '+(metersPerPixel()?'metres':'image pixels until calibration')+'.');else status('Select an exclusion. Drag its body to move, a vertex to reshape, or a circle rim to resize. Alt-drag moves a small outline; arrow keys move the selection 1 px (Shift: 10 px).');draw();updateButtons();}
 function cancel(){cancelDrag();if(draftBefore){const prior=draftBefore;draftBefore=null;restore(prior);}st.draft=[];st.mode='idle';drag=null;draw();updateButtons();status('Canceled only the unfinished drawing.');}
 function boundary(points){validatePolygon(points);checkpoint();const mask=new Uint8Array(st.w*st.h);for(let y=0;y<st.h;y++)for(let x=0;x<st.w;x++)if(contains(points,{x:x+.5,y:y+.5}))mask[y*st.w+x]=1;st.baseMask=mask;st.legacyMask=false;st.poly=copy(points);rebuild();}
 function finish(){try{if(st.mode==='poly')boundary(st.draft);else if(['exclude-poly','freehand'].includes(st.mode))addPolygon(st.draft,st.mode==='freehand'?'freehand':'polygon');else return false;st.draft=[];st.mode='idle';draw();updateButtons();status('Outline accepted. Existing exclusions and calibration retained. Recalculate the layout.');return true;}catch(e){status(e.message+' Draft retained. Undo the last vertex or cancel and redraw.','warn');return false;}}
 function simplify(points,tolerance=FREEHAND_TOLERANCE){if(points.length<3)return points;let input=points;if(Math.hypot(input[0].x-input.at(-1).x,input[0].y-input.at(-1).y)<tolerance)input=input.slice(0,-1);const keep=new Set([0,input.length-1]),stack=[[0,input.length-1]];while(stack.length){const [a,b]=stack.pop();let d=tolerance,index=-1;for(let i=a+1;i<b;i++){const distance=segmentDistance(input[i],input[a],input[b]);if(distance>d){d=distance;index=i;}}if(index!==-1){keep.add(index);stack.push([a,index],[index,b]);}}return [...keep].sort((a,b)=>a-b).map(i=>({...input[i]}));}
 function click(e){if(!st.img||locked)return;if(suppressClick){suppressClick=false;return;}const p=getXY(e);try{if(st.mode==='cal'){st.cal.push(p);resetResults();if(st.cal.length===2){if(!metersPerPixel()){status('Calibration is invalid; cancel and retry with a full Rhino length.','warn');return;}checkpoint(draftBefore);draftBefore=null;st.mode='idle';status('Scale calibrated. Pixel exclusion geometry is unchanged.');}else status('Click the opposite Rhino end.');setCalibrationLabels();describeSelection();}else if(['poly','exclude-poly','freehand'].includes(st.mode)){if(st.draft.length>=3&&Math.hypot(p.x-st.draft[0].x,p.y-st.draft[0].y)<=handleRadius())finish();else if(st.draft.length<MAX_VERTICES){st.draft.push(p);rigChanged();}else status('Draft reached 512 vertices. Finish or simplify the outline.','warn');}else if(st.mode==='seed'){st.mode='idle';detectPurple(p);}else if(st.mode==='circle'||st.mode==='exclude'){const radius=Number($('exclusionMeters').value)/(metersPerPixel()||1);addCircle(p,radius);st.mode='edit';status('Circle added. Drag its center/body or rim; Delete removes it.');}else if(st.mode==='edit'){const s=[...st.exclusions].reverse().find(s=>shapeContains(s,p));select(s?.id||null);}}catch(error){status(error.message,'warn');}draw();updateButtons();}
 function handleRadius(){const rect=canvas.getBoundingClientRect();return Math.max(2,8*st.w/Math.max(1,rect.width));}
 function pointerDown(e){if(!st.img||locked||e.button!==undefined&&e.button!==0)return;const p=getXY(e);if(st.mode==='freehand'){st.draft=[p];rigChanged();drag={kind:'freehand',pointer:e.pointerId};canvas.setPointerCapture?.(e.pointerId);e.preventDefault?.();return;}if(st.mode!=='edit')return;const radius=handleRadius();let s=selected(),handle=null;if(s?.type==='polygon'&&!e.altKey){const i=s.points.findIndex(v=>Math.hypot(p.x-v.x,p.y-v.y)<=radius);if(i>=0)handle={kind:'vertex',index:i};}else if(s?.type==='circle'){const distance=Math.hypot(p.x-s.x,p.y-s.y);if(distance<=Math.min(radius,s.radius/2))handle={kind:'move'};else if(Math.abs(distance-s.radius)<=radius&&!e.altKey)handle={kind:'radius'};}if(!handle){s=[...st.exclusions].reverse().find(s=>shapeContains(s,p));if(!s){select(null);return;}handle={kind:'move'};}select(s.id);drag={...handle,id:s.id,start:p,original:copy(s),before:capture(),pointer:e.pointerId,moved:false};canvas.setPointerCapture?.(e.pointerId);e.preventDefault?.();}
 function pointerMove(e){if(!drag)return;const p=getXY(e);if(drag.kind==='freehand'){if(st.draft.length<4096&&Math.hypot(p.x-st.draft.at(-1).x,p.y-st.draft.at(-1).y)>=.5)st.draft.push(p);draw();return;}const s=copy(drag.original),dx=p.x-drag.start.x,dy=p.y-drag.start.y;if(drag.kind==='radius')s.radius=Math.hypot(p.x-s.x,p.y-s.y);else if(drag.kind==='vertex')s.points[drag.index]=p;else if(s.type==='circle'){s.x+=dx;s.y+=dy;}else s.points=s.points.map(v=>({x:v.x+dx,y:v.y+dy}));drag.preview=s;drag.moved=Math.abs(dx)+Math.abs(dy)>.01;const index=st.exclusions.findIndex(v=>v.id===s.id);st.exclusions[index]=s;if(drag.moved)resetResults();draw();}
 function pointerUp(e){if(!drag)return;const d=drag;drag=null;canvas.releasePointerCapture?.(e.pointerId);if(d.kind==='freehand'){st.draft=simplify(st.draft);suppressClick=true;status('Freehand draft reduced at 1.5 px tolerance. Inspect it; Finish accepts, Escape cancels.');draw();updateButtons();return;}if(d.moved){suppressClick=true;try{validateShape(d.preview);if(st.baseMask)effectiveMask(st.baseMask,st.w,st.h,st.exclusions);checkpoint(d.before);rebuild();describeSelection();status('Exclusion updated. Recalculate the layout.');}catch(error){restore(d.before);status(error.message+' Original exclusion retained.','warn');}}else if(d.before)restore(d.before);else draw();updateButtons();}
 function cancelDrag(){if(!drag)return;const d=drag;drag=null;try{canvas.releasePointerCapture?.(d.pointer);}catch{}if(d.before)restore(d.before);else{st.draft=[];draw();}updateButtons();}
 function key(e){if(['INPUT','TEXTAREA','SELECT'].includes(e.target?.tagName))return;if(e.key==='Escape'){e.preventDefault();cancel();}else if(e.key==='Enter'){e.preventDefault();finish();}else if(e.key==='Backspace'){e.preventDefault();undo();}else if(e.key==='Delete'){e.preventDefault();deleteSelected();}else if(selected()&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();const step=e.shiftKey?10:1;try{moveShape(st.selectedExclusion,e.key==='ArrowLeft'?-step:e.key==='ArrowRight'?step:0,e.key==='ArrowUp'?-step:e.key==='ArrowDown'?step:0);}catch(error){status(error.message,'warn');}}else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?redo():undo();}else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'){e.preventDefault();redo();}}
 return {begin,finish,cancel,undo,redo,deleteSelected,clearExclusions,resetBoundary,resetCalibration,clearLayout,resetAnalysis,select,setSelectedRadius,describeSelection,addCircle,addPolygon,moveShape,moveVertex,resizeCircle,validateShape,validatePolygon,contains,polygonDistance,segmentDistance,simplify,boundary,effectiveMask,rebuild,checkpoint,clearHistory,capture,restore,click,pointerDown,pointerMove,pointerUp,cancelDrag,key,canUndo:()=>past.length>0,canRedo:()=>future.length>0,historySize:()=>({count:past.length,bytes:historyBytes}),limits:{MAX_SHAPES,MAX_VERTICES,HISTORY_BYTES,HISTORY_COUNT,FREEHAND_TOLERANCE}};
})();


function* layoutSteps(marginM,metPerPx,spacingM,fine){const w=st.w,h=st.h,box=st.bbox;const sp=spacingM/metPerPx*1.000125;const dy=sp*Math.sqrt(3)/2;const stepM=fine?4:12,angleStep=fine?3:12,stepPx=stepM/metPerPx;const m=marginM/metPerPx;
 if(!Number.isFinite(sp)||sp<3||sp>30000||!box)throw new Error('Invalid calibration/shape or spacing');let best=[],attempts=0,visited=0,exhausted=false;
 const corners=[[box.minx,box.miny],[box.maxx,box.miny],[box.minx,box.maxy],[box.maxx,box.maxy]];
 for(let deg=0;deg<60;deg+=angleStep){const a=deg*Math.PI/180,co=Math.cos(a),si=Math.sin(a),u=corners.map(p=>co*p[0]+si*p[1]),v=corners.map(p=>-si*p[0]+co*p[1]);const umin=Math.min(...u),umax=Math.max(...u),vmin=Math.min(...v),vmax=Math.max(...v);
 for(let yi=0;yi<Math.ceil(spacingM*Math.sqrt(3)/2/stepM);yi++){const py=yi*stepPx;for(let xi=0;xi<Math.ceil(spacingM/stepM);xi++){const px=xi*stepPx;attempts++;const points=[];
 for(let j=0;vmin+py+j*dy<=vmax+0.001;j++){const vr=vmin+py+j*dy,offset=(j&1)?sp/2:0;
 for(let k=0;umin+px+offset+k*sp<=umax+0.001;k++){const ur=umin+px+offset+k*sp,x=co*ur-si*vr,y=si*ur+co*vr;
 if(x<box.minx||x>box.maxx||y<box.miny||y>box.maxy)continue;
 visited++;if(visited%4096===0)yield;
 if(visited>st.workBudget){exhausted=true;break;}
 if(insetCheck(x,y,m)){if(points.some(p=>Math.hypot(x-p.x,y-p.y)<sp-1e-8))continue;points.push({x,y});if(points.length>128)throw new Error('More than 128 geometric positions: layout exceeds the supported candidate limit');}
 }if(exhausted)break;}if(points.length>best.length){best=points;}if(exhausted)break;}if(exhausted)break;}if(exhausted)break;}
 best.sort((a,b)=>(a.y-b.y)||(a.x-b.x));best.forEach((p,i)=>p.n=i+1);
 return{points:best,attempts,candidatesChecked:visited,complete:!exhausted,marginM,spacingM,search:fine?'3° / 4 m':'12° / 12 m'};}
// Synchronous entry for a bounded calculation; the interactive path yields for cancellation.
function layoutSolver(...args){const steps=layoutSteps(...args);let next;do{next=steps.next();}while(!next.done);return next.value;}
async function interactiveLayout(epoch,...args){
 const steps=layoutSteps(...args);
 while(epoch===rigEpoch){
  const next=steps.next();
  if(next.done)return next.value;
  await new Promise(resolve=>setTimeout(resolve,0));
 }
 throw new Error('Layout search canceled.');
}
function renderTable(){const s=st.result?.[st.scenario],mpp=metersPerPixel(),body=$('rigRows');body.replaceChildren();if(!s||!mpp)return;const origin=st.cal.length===2?{x:(st.cal[0].x+st.cal[1].x)/2,y:(st.cal[0].y+st.cal[1].y)/2}:{x:st.w/2,y:st.h/2};
 for(const p of s.points){const tr=document.createElement('tr');for(const str of ['R'+p.n,p.x.toFixed(1),p.y.toFixed(1),((p.x-origin.x)*mpp).toFixed(1),((p.y-origin.y)*mpp).toFixed(1)]){const td=document.createElement('td');td.textContent=str;tr.appendChild(td);}body.appendChild(tr);}}
function makePlan(selected='edge'){const mpp=metersPerPixel();if(!st.mask||!st.bbox){status('Trace a deposit boundary first.','warn');return;}if(!mpp){status('Calibrate using two Rhino endpoints and a valid reference length first.','warn');return;}
 const spacing=invalidNumber('spacingMeters',30,300),margin=invalidNumber('marginMeters',0,50);if(spacing===null||margin===null){status('Spacing or inset input invalid.','error');return;}status('Calculating finite hex-grid candidates. No game placement is attempted...');$('plan').disabled=true;
 const epoch=++rigEpoch;$('cancelRig').disabled=false;
 setTimeout(async()=>{try{const fine=$('fine').checked,safe=await interactiveLayout(epoch,margin,mpp,spacing,fine),edge=await interactiveLayout(epoch,0,mpp,spacing,fine);
 if(epoch!==rigEpoch)return;
 if(edge.points.length<safe.points.length){edge.points=safe.points.map(p=>({...p}));edge.retainedConservative=true;}
 st.result={safe,edge,mpp,spacing,referenceM:Number($('referenceMeters').value),referencePixels:Math.hypot(st.cal[1].x-st.cal[0].x,st.cal[1].y-st.cal[0].y),input:{format:st.source.detected_format||'image',width_px:st.w,height_px:st.h},maskArea:st.maskArea,bbox:st.bbox,calibrationLine:st.cal.map(p=>({...p})),method:'Finite hex grid with '+spacing+' m spacing; edge-allowed 0 m and optional '+margin+' m conservative inset',status:'EXPERIMENTAL_GEOMETRIC_LAYOUT'};
 st.scenario=selected==='safe'?'safe':'edge';$('safeCount').textContent=safe.points.length;$('edgeCount').textContent=edge.points.length;$('searchSummary').textContent=(safe.complete&&edge.complete?'Finite search completed. ':'WORK BUDGET REACHED — PARTIAL search. ')+safe.attempts.toLocaleString()+' / '+edge.attempts.toLocaleString()+' layouts tested (inset/edge).'+(edge.retainedConservative?' Edge used conservative feasible fallback.':'');
 status('Calculated a best-found candidate layout; inspect points and verify them through in-game deployment. This is not a maximum rig count.');rigChanged();renderSelection();updateButtons();renderTable();draw();}catch(err){if(epoch===rigEpoch){resetResults();status('Planner stopped: '+err.message,'error');draw();}}finally{$('cancelRig').disabled=true;updateButtons();}},15);}
function saveBlob(content,name,type){const blob=content instanceof Blob?content:new Blob([content],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function sourceBase(){return 'rig-layout';}
canvas.addEventListener('click',e=>Editor.click(e));
canvas.addEventListener('pointerdown',e=>Editor.pointerDown(e));
canvas.addEventListener('pointermove',e=>Editor.pointerMove(e));
canvas.addEventListener('pointerup',e=>Editor.pointerUp(e));
canvas.addEventListener('pointercancel',()=>Editor.cancelDrag());
canvas.addEventListener('keydown',e=>Editor.key(e));
$('auto').addEventListener('click',()=>detectPurple(null));
$('seed').addEventListener('click',()=>{resetResults();Editor.cancel();st.mode='seed';status('Click inside the desired purple region.');});
$('polygon').addEventListener('click',()=>Editor.begin('poly'));
$('undo').addEventListener('click',()=>Editor.undo());$('finish').addEventListener('click',()=>Editor.finish());
$('calibrate').addEventListener('click',()=>Editor.begin('cal'));
$('resetScale').addEventListener('click',()=>Editor.resetCalibration());
$('exclude').addEventListener('click',()=>Editor.begin('circle'));
for(const [id,fn] of Object.entries({redo:()=>Editor.redo(),cancelDrawing:()=>Editor.cancel(),excludePolygon:()=>Editor.begin('exclude-poly'),excludeFreehand:()=>Editor.begin('freehand'),editExclusions:()=>Editor.begin('edit'),deleteExclusion:()=>Editor.deleteSelected(),clearExclusions:()=>Editor.clearExclusions(),resetBoundary:()=>Editor.resetBoundary()}))if($(id))$(id).addEventListener('click',fn);
$('clearResult').addEventListener('click',()=>Editor.clearLayout());
$('threshold').addEventListener('input',()=>{$('thresholdLabel').textContent=$('threshold').value;rigChanged();});
$('referenceMeters').addEventListener('input',()=>{resetResults();setCalibrationLabels();Editor.describeSelection();draw();});
for(const id of ['spacingMeters','marginMeters'])$(id).addEventListener('input',()=>{resetResults();draw();});
$('fine').addEventListener('change',()=>{resetResults();draw();});$('plan').addEventListener('click',()=>makePlan());
for(const id of ['referenceMeters','spacingMeters','marginMeters']){let before=null;$(id).addEventListener('focus',()=>{before=Editor.capture();});$(id).addEventListener('change',()=>{if(before){Editor.checkpoint(before);before=null;updateButtons();}});$(id).addEventListener('blur',()=>{before=null;});}
if($('circleRadius'))$('circleRadius').addEventListener('change',()=>Editor.setSelectedRadius());
function selectedLayout(){return st.result?.[st.scenario]||null;}
function renderSelection(){
 const s=selectedLayout(),edge=st.scenario==='edge',inset=edge?0:Number($('marginMeters').value);
 $('selectedMode').textContent=edge?'EDGE-ALLOWED — 0 m boundary inset':'CONSERVATIVE — '+inset+' m boundary inset';
 $('primaryCount').textContent=s?s.points.length:'—';
 $('selectedAssumptions').textContent='Minimum center spacing: '+$('spacingMeters').value+' m. Selected additional inset: '+inset+' m.';
 $('toggleMargin').textContent=edge?'CONSERVATIVE — optional comparison':'EDGE-ALLOWED — 0 m (default)';
}
$('toggleMargin').addEventListener('click',()=>{st.scenario=st.scenario==='safe'?'edge':'safe';rigChanged();renderSelection();renderTable();draw();});
function exportCanvas(snapshot=exportSnapshot()){
 const out=document.createElement('canvas');out.width=Math.max(900,st.w);out.height=st.h+112;const c=out.getContext('2d');
 c.fillStyle='#102025';c.fillRect(0,0,out.width,out.height);c.drawImage(canvas,0,0);
 c.fillStyle='#fff';c.font='bold '+Math.max(12,Math.min(22,st.w/42))+'px Arial';c.textAlign='left';
 const s=snapshot.selected,label=snapshot.scenario==='edge'?'EDGE-ALLOWED':'CONSERVATIVE';
 c.fillText(label+' | '+s.points.length+' candidate centers | inset '+s.marginM+' m',12,st.h+28);
 c.font=Math.max(10,Math.min(16,st.w/55))+'px Arial';
 c.fillText('Spacing '+s.spacingM+' m | provisional reference '+snapshot.result.referenceM+' m',12,st.h+55);
 c.fillText('Geometric estimate. Check in game. Not verified deployable or maximum capacity.',12,st.h+82);
 return out;
}
function candidateCsv(snapshot=exportSnapshot()){
 const s=snapshot?.selected;if(!s)return '';
 const line=snapshot.result.calibrationLine,o={x:(line[0].x+line[1].x)/2,y:(line[0].y+line[1].y)/2};
 const rows=['candidate,image_x_px,image_y_px,right_from_reference_m,down_from_reference_m,scenario,boundary_inset_m,minimum_spacing_m,qualification'];
 for(const p of s.points)rows.push([p.n,p.x.toFixed(6),p.y.toFixed(6),((p.x-o.x)*snapshot.result.mpp).toFixed(6),((p.y-o.y)*snapshot.result.mpp).toFixed(6),snapshot.scenario==='edge'?'EDGE-ALLOWED':'CONSERVATIVE',s.marginM,s.spacingM,'Geometric estimate; unverified deployment'].join(','));
 return rows.join('\r\n')+'\r\n';
}
function exportSnapshot(){if(!st.result)return null;const result=JSON.parse(JSON.stringify(st.result)),scenario=st.scenario;return {result,scenario,selected:result[scenario]};}
$('savePng').addEventListener('click',()=>{if(!st.result)return;const snapshot=exportSnapshot(),output=exportCanvas(snapshot);output.toBlob(async b=>{try{if(!b)throw Error('PNG encoding failed.');const clean=await cleanPng(b);saveBlob(clean,sourceBase()+'-annotated-'+snapshot.scenario+'.png','image/png');}catch(e){status('PNG export stopped: '+e.message,'error');}},'image/png');});
$('saveCsv').addEventListener('click',()=>{const snapshot=exportSnapshot();if(snapshot)saveBlob(candidateCsv(snapshot),sourceBase()+'-'+snapshot.scenario+'-candidates.csv','text/csv');});
$('saveJson').addEventListener('click',()=>{const snapshot=exportSnapshot();if(!snapshot)return;saveBlob(JSON.stringify({...snapshot.result,activeScenario:snapshot.scenario,qualification:'Geometric estimate; no verified deployment or maximum capacity'},null,2),sourceBase()+'-'+snapshot.scenario+'-layout.json','application/json');});
$('printLayout').addEventListener('click',()=>{if(st.result)window.print();});
ctx.fillStyle='#13282b';ctx.fillRect(0,0,900,500);ctx.fillStyle='#b8c8c7';ctx.font='22px system-ui';ctx.textAlign='center';ctx.fillText('Choose a local image above',450,240);
