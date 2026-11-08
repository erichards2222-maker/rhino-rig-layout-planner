'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const {test} = require('node:test');

const {load,clone,wait,image,meta,prepare,discard}=require('./rig_harness.cjs');

test('full image reset is guarded and clears analysis without redetecting or replacing image preferences',async t=>{
 const a=load();t.after(()=>a.close());await prepare(a);a.el('analysisNotes').value='Remove on explicit reset';await a.el('analysisNotes').fire('input');
 const before=await a.App.projectText(),identity=clone(a.App.identity);
 const canceled=a.el('resetAnalysis').click();await wait(()=>a.el('unsavedDialog').open);await a.el('cancelReplace').click();await canceled;
 assert.equal(await a.App.projectText(),before);
 await discard(a,a.el('resetAnalysis').click());assert.deepEqual(clone(a.App.identity),identity);assert.ok(a.st.img);
 assert.equal(a.st.mask,null);assert.equal(a.st.baseMask,null);assert.equal(a.st.exclusions.length,0);assert.equal(a.st.cal.length,0);assert.equal(a.st.result,null);assert.equal(a.el('analysisNotes').value,'');assert.equal(a.Editor.canUndo(),false);assert.equal(a.st.scenario,'edge');assert.equal(a.Rig.settings().spacingMeters,30);
});

test('unfinished drawings cannot silently disappear through Save before image replacement',async t=>{
 const a=load();t.after(()=>a.close());await prepare(a);a.Editor.begin('exclude-poly');await a.el('imageCanvas').click(10,10);
 await assert.rejects(a.App.projectText(),/Finish or cancel/);
 const next=a.App.acceptImage(image(),meta('b'));await wait(()=>a.el('unsavedDialog').open);await a.el('saveAndContinue').click();assert.equal(await next,false);
 assert.equal(a.App.identity.sha256,'a'.repeat(64));assert.equal(a.st.draft.length,1);assert.equal(a.exports.length,0);
 a.Editor.cancel();assert.doesNotThrow(()=>a.Rig.parse(JSON.stringify({schema:'rig-layout-project',version:2,image:a.App.identity,rig:a.Rig.snapshot(),notes:'',calculation:null})));
});

test('edge selection follows fresh image, calibration and calculation; all presentation/export views agree',async t=>{
  const a=load();t.after(()=>a.close());assert.equal(a.st.scenario,'edge');await prepare(a);
  const s=a.st.result.edge;assert.ok(s.points.length>a.st.result.safe.points.length);
  assert.equal(a.st.scenario,'edge');assert.equal(a.el('primaryCount').textContent,s.points.length);
  assert.equal(a.el('rigRows').children.length,s.points.length);
  const csv=a.candidateCsv().trim().split('\r\n');assert.equal(csv.length,s.points.length+1);
  for(let i=1;i<csv.length;i++){
    const r=csv[i].split(','),p=s.points[i-1];
    assert.equal(+r[0],p.n);assert.ok(Math.abs(+r[1]-p.x)<1e-6);assert.ok(Math.abs(+r[2]-p.y)<1e-6);
    assert.equal(r[5],'EDGE-ALLOWED');assert.equal(+r[6],0);assert.equal(+r[7],30);
  }
  const output=a.exportCanvas(),labels=output.getContext().ops.filter(x=>x[0]==='fillText').map(x=>x[1]);
  assert.match(labels[0],new RegExp('EDGE-ALLOWED \\| '+s.points.length+' candidate centers \\| inset 0 m'));
  const markers=a.el('imageCanvas').getContext().ops.filter(x=>x[0]==='fillText').map(x=>x[1]);
  assert.deepEqual(markers,clone(s.points.map(p=>String(p.n))));
  await a.el('toggleMargin').click();assert.equal(a.st.scenario,'safe');assert.match(a.candidateCsv(),/CONSERVATIVE,20,30/);
  await a.el('calibrate').click();assert.equal(a.st.scenario,'edge');assert.equal(a.st.result,null);
});

test('zero-inset results retain mask, exclusion and center-spacing constraints',async t=>{
  const a=load();t.after(()=>a.close());await prepare(a);
  a.st.exclusions=[{x:60,y:50,radius:15}];
  a.st.mask[40*120+40]=0;
  const result=a.layoutSolver(0,1,30,false);
  for(let i=0;i<result.points.length;i++){
    const p=result.points[i];
    assert.equal(a.st.mask[Math.floor(p.y)*120+Math.floor(p.x)],1);
    assert.ok(Math.hypot(p.x-60,p.y-50)>15);
    for(const q of result.points.slice(0,i))assert.ok(Math.hypot(p.x-q.x,p.y-q.y)>=30);
  }
  assert.ok(result.points.length);
});

test('conservative choice survives exact project reopen and image reconnection; new image resets calibration and edge',async t=>{
  const a=load();t.after(()=>a.close());await prepare(a);await a.el('toggleMargin').click();
  a.el('analysisNotes').value='Synthetic analysis';const text=await a.App.projectText(),saved=JSON.parse(text);
  assert.equal(saved.rig.selected,'safe');assert.match(saved.calculation.id,/^layout-[a-f0-9]{64}$/);
  const b=load();t.after(()=>b.close());await b.App.openText(text);assert.equal(b.st.img,null);
  await b.App.acceptImage(image(),meta());await wait(()=>!!b.st.result);
  assert.equal(b.st.scenario,'safe');assert.equal(b.el('primaryCount').textContent,b.st.result.safe.points.length);
  assert.deepEqual(clone(b.st.cal),saved.rig.cal);assert.equal(b.el('analysisNotes').value,'Synthetic analysis');
  await discard(b,b.App.acceptImage(image(),meta('b')));
  assert.equal(b.st.scenario,'edge');assert.equal(b.st.cal.length,0);assert.equal(b.st.result,null);assert.equal(b.metersPerPixel(),null);
});

test('wrong image fingerprint and dimensions retain pending project and do not install annotations',async t=>{
  const a=load();t.after(()=>a.close());await prepare(a);const text=await a.App.projectText();
  const b=load();t.after(()=>b.close());await b.App.openText(text);const before=JSON.stringify(b.App.pending);
  await assert.rejects(b.App.acceptImage(image(),meta('b')),/fingerprint/);
  assert.equal(JSON.stringify(b.App.pending),before);assert.equal(b.st.img,null);
  await assert.rejects(b.App.acceptImage(image(121,100),{...meta(),sourceWidth:121}),/dimensions/);
  assert.equal(JSON.stringify(b.App.pending),before);assert.equal(b.st.img,null);
});

test('equivalent image identity remains reconnectable after JSON object keys are reordered',async t=>{
  const a=load();t.after(()=>a.close());await prepare(a);const p=JSON.parse(await a.App.projectText());
  p.image=Object.fromEntries(Object.entries(p.image).reverse());
  const b=load();t.after(()=>b.close());await b.App.openText(JSON.stringify(p));
  await b.App.acceptImage(image(),meta());assert.equal(b.App.pending,null);assert.equal(b.st.cal.length,2);
});

test('malformed/future/unsafe project inputs fail without changing existing markings or showing discard dialog',async t=>{
  const a=load();t.after(()=>a.close());await prepare(a);
  const baseline=await a.App.projectText(),p=JSON.parse(baseline);
  for(const bad of ['{',JSON.stringify({...p,version:999}),baseline.replace('"schema":','"__proto__":{}, "schema":'),
                    JSON.stringify({...p,rig:{...p.rig,cal:[{x:Infinity,y:0}]}}),
                    JSON.stringify({...p,image:{...p.image,sha256:'wrong'}})]){
    await assert.rejects(a.App.openText(bad));assert.equal(await a.App.projectText(),baseline);assert.equal(a.el('unsavedDialog').open,false);
  }
});

test('missing older selection defaults to edge; explicit legacy extraction retains only approved image markings',async t=>{
  const a=load();t.after(()=>a.close());await prepare(a);const oldRig=clone(a.Rig.snapshot());delete oldRig.selected;
  const original=JSON.stringify({schema:'surface-mining-project',version:1,rig:oldRig,notes:'EXAMPLE_UNUSED_NOTE',context:{unused:'omit'}});
  const migrated=a.Rig.parse(original,true);
  assert.equal(migrated.rig.selected,'edge');assert.equal(migrated.notes,'');assert.equal(migrated.image,null);
  assert.equal(JSON.stringify(migrated).includes('EXAMPLE_UNUSED_NOTE'),false);
  const b=load();t.after(()=>b.close());await b.App.openText(original,true);
  await assert.rejects(b.App.projectText(),/Reconnect/);
  await b.App.acceptImage(image(),meta());const clean=JSON.parse(await b.App.projectText());
  assert.equal(clean.rig.selected,'edge');assert.equal(clean.schema,'rig-layout-project');assert.deepEqual(Object.keys(clean),['schema','version','image','rig','notes','calculation']);
  assert.equal(original.includes('EXAMPLE_UNUSED_NOTE'),true);
});

test('unsaved replacement cancel preserves work; discard replaces only after explicit action',async t=>{
  const a=load();t.after(()=>a.close());await prepare(a);
  const before=await a.App.projectText(),next=a.App.acceptImage(image(),meta('b'));
  await wait(()=>a.el('unsavedDialog').open);await a.el('cancelReplace').click();
  assert.equal(await next,false);assert.equal(await a.App.projectText(),before);
  assert.equal(await discard(a,a.App.acceptImage(image(),meta('b'))),true);
  assert.equal(a.App.identity.sha256,'b'.repeat(64));assert.equal(a.st.cal.length,0);
});

test('save-before-replacement produces a reopenable project before installing the next image',async t=>{
  const a=load();t.after(()=>a.close());await prepare(a);
  const previous=await a.App.projectText(),next=a.App.acceptImage(image(),meta('b'));
  await wait(()=>a.el('unsavedDialog').open);await a.el('saveAndContinue').click();assert.equal(await next,true);
  assert.equal(a.exports.length,1);assert.equal(await a.exports[0].blob.text(),previous);
  assert.equal(a.App.identity.sha256,'b'.repeat(64));
});

test('denied browser preference storage retains the current session and usable project export',async t=>{
  const a=load({storageDenied:true});t.after(()=>a.close());await prepare(a);
  await a.el('spacingMeters').fire('change');
  assert.match(a.el('saveStatus').textContent,/preferences unavailable/);
  const text=await a.App.projectText();assert.equal(a.Rig.parse(text).image.sha256,'a'.repeat(64));
});

test('canceling a finite search prevents its deferred result from replacing current state',async t=>{
  const a=load();t.after(()=>a.close());await prepare(a);await a.el('clearResult').click();
  const inputs=clone(a.Rig.snapshot());a.makePlan();await a.el('cancelRig').click();
  await new Promise(resolve=>setTimeout(resolve,35));
  assert.equal(a.st.result,null);assert.equal(a.st.scenario,'edge');assert.deepEqual(clone(a.Rig.snapshot()),inputs);
});

test('pending project saves and reconnects explicitly edited settings without silently restoring the older assumptions',async t=>{
  const a=load();t.after(()=>a.close());await prepare(a);await a.el('toggleMargin').click();
  const raw=await a.App.projectText(),b=load();t.after(()=>b.close());await b.App.openText(raw);
  b.el('analysisNotes').value='Additional note';await b.el('analysisNotes').fire('input');
  assert.equal(JSON.parse(await b.App.projectText()).rig.selected,'safe');
  b.el('spacingMeters').value='150';await b.el('spacingMeters').fire('input');await b.el('spacingMeters').fire('change');
  const edited=JSON.parse(await b.App.projectText());
  assert.equal(edited.rig.settings.spacingMeters,150);assert.equal(edited.calculation,null);assert.equal(edited.rig.selected,'edge');
  await b.App.save();assert.equal(JSON.parse(await b.exports.at(-1).blob.text()).rig.settings.spacingMeters,150);
  await b.App.acceptImage(image(),meta());assert.equal(b.Rig.settings().spacingMeters,150);assert.equal(b.st.scenario,'edge');
  assert.equal(JSON.parse(raw).rig.settings.spacingMeters,30);
});

test('transient queue fetch errors retry without decode rejection; successful decode and genuine corruption remain distinct',async t=>{
  const id='f'.repeat(64),calls=[];
  const state={folder:'synthetic',folderAvailable:true,scanComplete:true,history:[],notice:'',images:[{id,state:'candidate',loaded:false}]};
  let locked=true,corrupt=false;
  const network=async(url,options)=>{
    calls.push(url);
    if(url.startsWith('/api/image'))return {ok:!locked,json:async()=>locked?{error:'Temporarily locked'}:{dataUrl:corrupt?'corrupt':'synthetic-decoded-image'}};
    if(url==='/api/validated'){const body=JSON.parse(options.body);state.images[0].state=body.ok?'ready':'rejected';}
    return {ok:true,json:async()=>clone(state)};
  };
  const a=load({network});t.after(()=>a.close());
  await wait(()=>calls.filter(x=>x==='/api/state').length>=2);
  assert.equal(state.images[0].state,'candidate');assert.equal(calls.includes('/api/validated'),false);
  locked=false;await a.App.poll();assert.equal(state.images[0].state,'ready');
  state.images[0].state='candidate';corrupt=true;await a.App.poll();assert.equal(state.images[0].state,'rejected');
});

test('local companion preferences restore once and serialize newer changes instead of relying on a previous port origin',async t=>{
  const defaults={referenceMeters:14,spacingMeters:100,marginMeters:8,exclusionMeters:15,threshold:22,fine:false};
  const state={folder:'synthetic',folderAvailable:true,scanComplete:true,history:[],notice:'',images:[],preferences:defaults};
  const writes=[],calls=[];
  const network=async(url,options)=>{
    calls.push(url);
    if(url==='/api/preferences'){
      const next=JSON.parse(options.body).preferences;writes.push(next);
      if(writes.length===1)await new Promise(resolve=>setTimeout(resolve,20));
      state.preferences=next;
    }
    return {ok:true,json:async()=>clone(state)};
  };
  const a=load({network});t.after(()=>a.close());await wait(()=>calls.length>=2);
  assert.deepEqual(clone(a.Rig.settings()),defaults);
  a.el('spacingMeters').value='110';await a.el('spacingMeters').fire('change');
  a.el('spacingMeters').value='120';await a.el('spacingMeters').fire('change');
  await wait(()=>writes.length===2);await wait(()=>state.preferences.spacingMeters===120);
  assert.deepEqual(writes.map(x=>x.spacingMeters),[110,120]);
  state.preferences={...defaults,spacingMeters:200};await a.App.poll();
  assert.equal(a.Rig.settings().spacingMeters,120);
});

test('reconnecting an image retains unsaved pending notes and settings and still guards the next replacement',async t=>{
  const a=load();t.after(()=>a.close());await prepare(a);const original=await a.App.projectText();
  const b=load();t.after(()=>b.close());await b.App.openText(original);
  b.el('analysisNotes').value='Unsaved note';await b.el('analysisNotes').fire('input');
  b.el('spacingMeters').value='150';await b.el('spacingMeters').fire('input');
  assert.equal(b.App.dirty,true);await b.App.acceptImage(image(),meta());
  assert.equal(b.App.dirty,true);assert.equal(b.Rig.settings().spacingMeters,150);
  assert.equal(b.el('analysisNotes').value,'Unsaved note');assert.equal(b.st.result,null);
  const before=await b.App.projectText(),replace=b.App.acceptImage(image(),meta('b'));
  await wait(()=>b.el('unsavedDialog').open);await b.el('cancelReplace').click();
  assert.equal(await replace,false);assert.equal(await b.App.projectText(),before);assert.equal(b.App.dirty,true);
  assert.equal(JSON.parse(original).rig.settings.spacingMeters,30);
});
