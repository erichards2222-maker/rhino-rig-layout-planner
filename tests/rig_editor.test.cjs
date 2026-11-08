'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{webcrypto}=require('node:crypto');
function load(){
 const elements=new Map(),context={beginPath(){},arc(){},stroke(){},fill(){},closePath(){},moveTo(){},lineTo(){},drawImage(){},clearRect(){},fillRect(){},fillText(){},putImageData(){},createImageData(w,h){return{data:new Uint8ClampedArray(w*h*4)}}};
 function element(){const handlers={};return{value:'',checked:false,style:{},disabled:false,hidden:false,textContent:'',handlers,addEventListener(k,f){(handlers[k]??=[]).push(f)},fire(k,e={}){for(const f of handlers[k]||[])f({target:this,preventDefault(){},...e})},getContext:()=>context,getBoundingClientRect:()=>({left:0,top:0,width:100,height:100}),replaceChildren(){},appendChild(){},setPointerCapture(){},releasePointerCapture(){}};}
 const el=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
 const document={getElementById:el,createElement:element};
 const sandbox={document,crypto:webcrypto,TextEncoder,Uint8Array,Uint8ClampedArray,Blob,setTimeout,clearTimeout,window:{print(){}},btoa:s=>Buffer.from(s,'binary').toString('base64'),atob:s=>Buffer.from(s,'base64').toString('binary')};
 const source=['rig.js','rig_session.js'].map(f=>fs.readFileSync(path.join(__dirname,'../src',f),'utf8')).join('\n');
 const a=vm.runInNewContext(source+'\n;({Editor,Rig,st,insetCheck,layoutSolver,metersPerPixel,resetResults,exportSnapshot,candidateCsv})',sandbox);
 a.Rig.setSettings({...JSON.parse(JSON.stringify(a.Rig.defaults)),referenceMeters:10,spacingMeters:30,marginMeters:1,fine:false});
 Object.assign(a.st,{w:100,h:100,img:{},base:null,baseMask:new Uint8Array(10000).fill(1),mask:new Uint8Array(10000).fill(1),bbox:{minx:0,miny:0,maxx:99,maxy:99},cal:[{x:0,y:0},{x:10,y:0}]});
 return{...a,el};
}
const clone=o=>JSON.parse(JSON.stringify(o));
const rect=(x,y,w,h)=>[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];

test('Escape and Undo roll back active drag previews before clearing the transaction',()=>{
 const event=(x,y)=>({clientX:x,clientY:y,pointerId:1,button:0,preventDefault(){}});
 for(const type of ['circle','polygon'])for(const command of ['Escape','Undo']){
  const a=load(),id=type==='circle'?a.Editor.addCircle({x:40,y:40},8):a.Editor.addPolygon(rect(20,20,40,40));
  a.Editor.begin('edit');a.Editor.select(id);const before=clone(a.Rig.snapshot()),count=a.Editor.historySize().count;
  a.Editor.pointerDown(event(type==='circle'?40:20,type==='circle'?40:20));a.Editor.pointerMove(event(65,40));
  if(command==='Escape')a.Editor.key({key:'Escape',target:{tagName:'CANVAS'},preventDefault(){}});else a.Editor.undo();
  a.Editor.pointerMove(event(70,40));a.Editor.pointerUp(event(70,40));assert.deepEqual(clone(a.Rig.snapshot()),before);assert.equal(a.Editor.historySize().count,count);
  assert.doesNotThrow(()=>a.Rig.parse(JSON.stringify({schema:'rig-layout-project',version:2,image:{sha256:'a'.repeat(64),width:100,height:100,workingWidth:100,workingHeight:100},rig:a.Rig.snapshot(),notes:'',calculation:null})));
 }
});
test('concave, overlapping and outside polygons derive a reversible union without changing the base',()=>{
 const a=load(),base=a.st.baseMask.slice();
 const concave=[{x:10,y:10},{x:50,y:10},{x:50,y:20},{x:20,y:20},{x:20,y:50},{x:10,y:50}];
 const first=a.Editor.addPolygon(concave),second=a.Editor.addPolygon(rect(15,15,20,20)),third=a.Editor.addPolygon(rect(-10,70,30,40));
 assert.equal(a.st.mask[15*100+15],0);assert.equal(a.st.mask[30*100+30],0);assert.equal(a.st.mask[40*100+40],1);assert.equal(a.st.mask[80*100+5],0);
 a.Editor.select(first);a.Editor.deleteSelected();assert.equal(a.st.mask[12*100+12],1);assert.equal(a.st.mask[20*100+20],0);
 a.Editor.select(second);a.Editor.deleteSelected();assert.equal(a.st.mask[20*100+20],1);
 a.Editor.clearExclusions();assert.deepEqual(a.st.mask,base);assert.deepEqual(a.st.baseMask,base);
 assert.equal(new Set([first,second,third]).size,3);
});
test('true subpixel polygon holes and exact conservative face clearance constrain the unchanged solver',()=>{
 const a=load();a.Editor.addPolygon(rect(40.125,40.125,.25,.25));
 assert.equal(a.st.mask[40*100+40],1);assert.equal(a.insetCheck(40.25,40.25,0),false);
 assert.equal(a.insetCheck(40.375,40.25,0),false);assert.equal(a.insetCheck(40.38,40.25,0),true);
 assert.equal(a.insetCheck(41.375,40.25,1),true);assert.equal(a.insetCheck(41.374,40.25,1),false);
 const polygon=a.st.exclusions[0];
 for(const margin of [0,2]){const result=a.layoutSolver(margin,1,30,false);for(const p of result.points){assert.equal(a.Editor.contains(polygon.points,p),false);assert.ok(a.Editor.polygonDistance(polygon.points,p)>=margin-1e-12);}}
});
test('circles resize/move/delete with stable identity and undo/redo restores the base',()=>{
 const a=load(),id=a.Editor.addCircle({x:40,y:40},5);a.Editor.moveShape(id,10,0);a.Editor.resizeCircle(id,8);
 assert.equal(a.st.exclusions[0].id,id);assert.equal(a.st.mask[40*100+40],1);assert.equal(a.st.mask[40*100+50],0);
 a.Editor.undo();assert.equal(a.st.exclusions[0].radius,5);a.Editor.undo();assert.equal(a.st.exclusions[0].x,40);
 a.Editor.redo();assert.equal(a.st.exclusions[0].x,50);a.Editor.select(id);a.Editor.deleteSelected();assert.equal(a.st.mask[40*100+50],1);
 a.Editor.undo();assert.equal(a.st.exclusions[0].id,id);assert.equal(a.st.mask[40*100+50],0);
});
test('polygon vertex editing rejects self-intersection atomically and geometry history stays bounded',()=>{
 const a=load(),id=a.Editor.addPolygon(rect(10,10,20,20)),before=clone(a.st.exclusions);
 assert.throws(()=>a.Editor.moveVertex(id,1,{x:5,y:25}),/crosses|touches/);assert.deepEqual(clone(a.st.exclusions),before);
 a.Editor.moveVertex(id,1,{x:35,y:10});assert.equal(a.st.exclusions[0].points[1].x,35);a.Editor.undo();assert.deepEqual(clone(a.st.exclusions),before);
 for(let i=0;i<50;i++)a.Editor.moveShape(id,.1,0);
 assert.ok(a.Editor.historySize().count<=32);assert.ok(a.Editor.historySize().bytes<=24*1024*1024);
 for(const bad of [[],[{x:0,y:0},{x:1,y:1},{x:2,y:2}],rect(1,1,1,1).map((p,i)=>i===2?{x:NaN,y:2}:p)])assert.throws(()=>a.Editor.addPolygon(bad));
});
test('freehand simplification is bounded by stated tolerance; invalid drafts remain for correction',()=>{
 const a=load(),points=[];for(let x=10;x<40;x++)points.push({x,y:10});for(let y=10;y<40;y++)points.push({x:40,y});for(let x=40;x>10;x--)points.push({x,y:40});for(let y=40;y>10;y--)points.push({x:10,y});
 const reduced=a.Editor.simplify(points);assert.ok(reduced.length<points.length);assert.doesNotThrow(()=>a.Editor.validatePolygon(reduced));
 for(const p of points)assert.ok(a.Editor.polygonDistance(reduced,p)<=1.5+1e-9);
 a.Editor.begin('freehand');a.st.draft=[{x:10,y:10},{x:40,y:40},{x:40,y:10},{x:10,y:40}];assert.equal(a.Editor.finish(),false);assert.equal(a.st.draft.length,4);assert.equal(a.st.exclusions.length,0);
 a.Editor.undo();assert.equal(a.st.draft.length,3);a.Editor.cancel();assert.equal(a.st.draft.length,0);assert.equal(a.st.exclusions.length,0);
});
test('each reset preserves its documented inputs; undo restores geometry and calibration while full reset clears history',()=>{
 const a=load(),id=a.Editor.addCircle({x:40,y:40},5),cal=clone(a.st.cal);
 a.Editor.resetBoundary();assert.equal(a.st.mask,null);assert.equal(a.st.exclusions[0].id,id);assert.deepEqual(clone(a.st.cal),cal);
 a.Editor.undo();assert.equal(a.st.mask[40*100+40],0);
 a.Editor.resetCalibration();assert.equal(a.st.cal.length,0);assert.equal(a.st.exclusions[0].radius,5);a.Editor.undo();assert.deepEqual(clone(a.st.cal),cal);
 a.Editor.clearExclusions();assert.equal(a.st.mask[40*100+40],1);a.Editor.undo();assert.equal(a.st.mask[40*100+40],0);
 a.el('analysisNotes').value='Local note';a.st.scenario='safe';a.Editor.resetAnalysis();
 assert.equal(a.st.img!==null,true);assert.equal(a.st.mask,null);assert.equal(a.st.cal.length,0);assert.equal(a.st.exclusions.length,0);assert.equal(a.st.scenario,'edge');assert.equal(a.el('analysisNotes').value,'');assert.equal(a.Editor.canUndo(),false);assert.equal(a.Rig.settings().spacingMeters,30);
});
test('v2 project round-trip validates base, effective mask and shape IDs; contradictory data is rejected',()=>{
 const a=load();a.Editor.addPolygon(rect(30,30,20,20));a.st.scenario='safe';
 const rig=a.Rig.snapshot(),image={sha256:'a'.repeat(64),width:100,height:100,workingWidth:100,workingHeight:100};
 const original=JSON.stringify({schema:'rig-layout-project',version:2,image,rig,notes:'local note',calculation:null});
 const parsed=a.Rig.parse(original);assert.equal(parsed.rig.selected,'safe');a.Editor.clearExclusions();a.Rig.apply(parsed.rig);assert.equal(a.st.mask[40*100+40],0);
 const bad=JSON.parse(original);bad.rig.mask=bad.rig.baseMask;assert.throws(()=>a.Rig.parse(JSON.stringify(bad)),/contradict/);
 const duplicate=JSON.parse(original);duplicate.rig.exclusions.push(clone(duplicate.rig.exclusions[0]));assert.throws(()=>a.Rig.parse(JSON.stringify(duplicate)),/Duplicate/);
 assert.equal(JSON.parse(original).rig.selected,'safe');assert.equal(a.st.exclusions.length,1);
});
test('v1 migration never reconstructs erased pixels and re-detection establishes a new editable base',()=>{
 const a=load(),oldMask=new Uint8Array(10000).fill(1);oldMask[40*100+40]=0;
 const old={width:100,height:100,settings:clone(a.Rig.defaults),mask:a.Rig.pack(oldMask),cal:[],poly:[],exclusions:[{x:40.5,y:40.5,radius:.2}],selected:'safe'};
 const image={sha256:'a'.repeat(64),width:100,height:100,workingWidth:100,workingHeight:100};
 const raw=JSON.stringify({schema:'rig-layout-project',version:1,image,rig:old,notes:'',calculation:null}),parsed=a.Rig.parse(raw);
 assert.equal(parsed.version,2);assert.equal(parsed.rig.legacyMask,true);a.Rig.apply(parsed.rig);a.Editor.clearExclusions();assert.equal(a.st.mask[40*100+40],0);
 a.Editor.boundary(rect(0,0,100,100));assert.equal(a.st.legacyMask,false);assert.equal(a.st.mask[40*100+40],1);assert.equal(JSON.parse(raw).version,1);
});
test('calibration changes retain pixel geometry; selected radius is separate from next-circle preference',()=>{
 const a=load(),id=a.Editor.addCircle({x:40,y:40},10);a.el('exclusionMeters').value='12';
 a.Editor.resetCalibration();assert.equal(a.st.exclusions[0].radius,10);a.el('circleRadius').value='20';a.Editor.setSelectedRadius();assert.equal(a.st.exclusions[0].radius,20);assert.equal(a.el('exclusionMeters').value,'12');
 a.Editor.undo();assert.equal(a.st.exclusions[0].radius,10);a.Editor.undo();assert.equal(a.metersPerPixel(),1);assert.equal(a.st.exclusions[0].id,id);
});


test('pointer center dragging and canvas keyboard commands move a small selected circle without resizing it',()=>{
 const a=load(),id=a.Editor.addCircle({x:40,y:40},3);a.Editor.begin('edit');a.Editor.select(id);
 const event=(x,y)=>({clientX:x,clientY:y,pointerId:1,button:0,preventDefault(){}});
 a.Editor.pointerDown(event(40,40));a.Editor.pointerMove(event(45,42));a.Editor.pointerUp(event(45,42));
 assert.equal(a.st.exclusions[0].x,45);assert.equal(a.st.exclusions[0].y,42);assert.equal(a.st.exclusions[0].radius,3);
 a.Editor.key({key:'ArrowRight',shiftKey:true,target:{tagName:'CANVAS'},preventDefault(){}});assert.equal(a.st.exclusions[0].x,55);
 a.Editor.undo();assert.equal(a.st.exclusions[0].x,45);a.Editor.undo();assert.equal(a.st.exclusions[0].x,40);
});
test('reference input changes have an undo snapshot; canceling calibration restores prior endpoints',()=>{
 const a=load(),before=clone(a.st.cal);a.el('referenceMeters').fire('focus');a.el('referenceMeters').value='20';a.el('referenceMeters').fire('input');a.el('referenceMeters').fire('change');
 assert.equal(a.metersPerPixel(),2);a.Editor.undo();assert.equal(a.metersPerPixel(),1);
 a.Editor.begin('cal');a.Editor.click({clientX:25,clientY:25});assert.equal(a.st.cal.length,1);a.Editor.cancel();assert.deepEqual(clone(a.st.cal),before);
 assert.equal(a.metersPerPixel(),1);
});
