'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {load,clone,wait,image,meta,discard}=require('./rig_harness.cjs');
async function navigate(a,fn){const dirty=a.App.dirty,promise=fn();return dirty?discard(a,promise):promise;}
const item=(letter,time,state='ready')=>({id:letter.repeat(64),name:letter+'.png',mtimeNs:time*1000000,state,loaded:true});
function server(images){
 const state={folder:'synthetic',folderAvailable:true,scanComplete:true,discoveryComplete:true,images,history:[],notice:''};
 const calls=[];let failed=false,hold=null;
 return {state,calls,set failed(v){failed=v;},set hold(v){hold=v;},async network(url,options){
  calls.push(url);if(failed)throw Error('Synthetic connection failure');
  if(url.startsWith('/api/image')){
   const id=new URL('http://127.0.0.1'+url).searchParams.get('id');if(hold)await hold(id);
   return {ok:true,json:async()=>({dataUrl:'synthetic',sha256:id,format:'png',sourceWidth:24,sourceHeight:24})};
  }
  if(url==='/api/validated'){const body=JSON.parse(options.body);state.images.find(i=>i.id===body.id).state=body.ok?'ready':'rejected';}
  if(url==='/api/loaded'){const body=JSON.parse(options.body);state.images.find(i=>i.id===body.id).loaded=true;}
  return {ok:true,json:async()=>clone(state)};
 }};
}

test('clean launch selects newest and browsing includes all already-viewed images without wrapping',async t=>{
 const s=server([item('a',1),item('b',2),item('c',3)]),a=load({network:s.network});t.after(()=>a.close());
 await wait(()=>a.App.currentId==='c'.repeat(64));
 assert.equal(a.App.neighbor(1),null);assert.equal(a.App.neighbor(-1),'b'.repeat(64));
 await navigate(a,()=>a.el('olderImage').click());await wait(()=>a.App.currentId==='b'.repeat(64));
 await navigate(a,()=>a.el('olderImage').click());await wait(()=>a.App.currentId==='a'.repeat(64));
 assert.equal(a.App.neighbor(-1),null);assert.equal(a.el('olderImage').disabled,true);
 await navigate(a,()=>a.el('newerImage').click());await wait(()=>a.App.currentId==='b'.repeat(64));
 await navigate(a,()=>a.el('loadLatest').click());await wait(()=>a.App.currentId==='c'.repeat(64));
 assert.match(a.el('imagePosition').textContent,/Image 3 of 3/);
});

test('pending and unreadable records cannot block ready neighbors; incoming files retain cursor',async t=>{
 const s=server([item('a',1,'rejected'),item('b',2),item('c',3)]),a=load({network:s.network});t.after(()=>a.close());
 s.state.files=[item('z',4,'pending'),...s.state.images];await wait(()=>a.App.currentId==='c'.repeat(64));
 assert.equal(a.App.neighbor(-1),'b'.repeat(64));
 s.state.images.push(item('d',5));await a.App.poll();assert.equal(a.App.currentId,'c'.repeat(64));assert.equal(a.App.neighbor(1),'d'.repeat(64));
 assert.match(a.el('queueNotice').textContent,/still being written/);
});

test('empty clean startup waits then opens first ready file, but manual selection cancels startup auto-open',async t=>{
 const s=server([]),a=load({network:s.network});t.after(()=>a.close());await wait(()=>s.calls.length>=2);
 s.state.images.push(item('a',1));await a.App.poll();assert.equal(a.App.currentId,'a'.repeat(64));
 const s2=server([]),b=load({network:s2.network});t.after(()=>b.close());await wait(()=>s2.calls.length>=2);
 await b.App.acceptImage(image(),meta('b'));s2.state.images.push(item('c',3));await b.App.poll();
 assert.equal(b.App.identity.sha256,'b'.repeat(64));assert.equal(b.App.currentId,null);
});

test('edited analysis and Cancel preserve identity, notes, geometry and scenario during chronological navigation',async t=>{
 const s=server([item('a',1),item('b',2)]),a=load({network:s.network});t.after(()=>a.close());await wait(()=>a.App.currentId==='b'.repeat(64));
 a.el('analysisNotes').value='Synthetic unsaved note';await a.el('analysisNotes').fire('input');
 const before=await a.App.projectText(),request=a.App.loadQueued('a'.repeat(64));
 await wait(()=>a.el('unsavedDialog').open);await a.el('cancelReplace').click();assert.equal(await request,false);
 assert.equal(a.App.currentId,'b'.repeat(64));assert.equal(await a.App.projectText(),before);assert.equal(a.App.dirty,true);
});

test('late image response cannot replace later manual image selection',async t=>{
 const s=server([item('a',1),item('b',2)]),a=load({network:s.network});t.after(()=>a.close());await wait(()=>a.App.currentId==='b'.repeat(64));
 let release;s.hold=()=>new Promise(r=>{release=r;});const request=a.App.loadQueued('a'.repeat(64));await wait(()=>!!release);
 a.el('analysisNotes').value='Keep this edit';await a.el('analysisNotes').fire('input');release();
 assert.equal(await request,false);assert.equal(a.App.currentId,'b'.repeat(64));assert.equal(a.el('analysisNotes').value,'Keep this edit');
});

test('deleted current file retains analysis and offers surviving chronological neighbors',async t=>{
 const s=server([item('a',1),item('b',2),item('c',3)]),a=load({network:s.network});t.after(()=>a.close());await wait(()=>a.App.currentId==='c'.repeat(64));
 await navigate(a,()=>a.App.loadQueued('b'.repeat(64)));s.state.images=s.state.images.filter(i=>i.id!=='b'.repeat(64));await a.App.poll();
 assert.equal(a.App.currentId,'b'.repeat(64));assert.equal(a.App.neighbor(-1),'a'.repeat(64));assert.equal(a.App.neighbor(1),'c'.repeat(64));
 assert.match(a.el('imagePosition').textContent,/no longer available/);
});

test('disconnection differs from empty directory and Refresh recovers without permanently disabled controls',async t=>{
 const s=server([]),a=load({network:s.network});t.after(()=>a.close());await wait(()=>s.calls.length>=2);
 s.failed=true;await a.App.poll();assert.equal(a.el('connectionStatus').textContent,'Companion unavailable');
 assert.equal(a.el('refreshSource').disabled,false);s.failed=false;await a.el('refreshSource').click();
 await wait(()=>a.el('connectionStatus').textContent==='Windows-local screenshot companion');assert.equal(a.el('refreshSource').disabled,false);
});

test('tied timestamps retain backend stable order and saved-project intent prevents startup replacement',async t=>{
 const s=server([item('a',1),item('b',1),item('c',1)]),a=load({network:s.network});t.after(()=>a.close());
 await a.el('openProject').click();await wait(()=>s.calls.length>=2);await a.App.poll();assert.equal(a.st.img,null);
 await a.App.loadQueued('b'.repeat(64));assert.equal(a.App.neighbor(-1),'a'.repeat(64));assert.equal(a.App.neighbor(1),'c'.repeat(64));
});
