const App = (() => {
 let dirty=false,revision=0,suppress=false,pending=null,imageIdentity=null,currentId=null,busy=false,stopped=false;
 let bridge=null,queue=null,polling=false,lastFolder=null,preferencesLoaded=false,preferenceWrites=Promise.resolve();
 let sourceEpoch=0,folderEpoch=0,stateEpoch=0,userTouched=false,connected=false,currentItem=null,autoOpened=false;
 function syncPendingSettings(){
  if(!pending)return false;
  const current=Rig.settings();
  if(Object.keys(Rig.defaults).every(k=>pending.rig.settings[k]===current[k]))return false;
  pending.rig.settings=current;pending.rig.selected='edge';pending.calculation=null;return true;
 }
 function mark(){if(!suppress){syncPendingSettings();dirty=true;revision++;sourceEpoch++;userTouched=true;$('saveStatus').textContent='Unsaved analysis';}}
 rigChanged=mark;
 function clean(){dirty=false;$('saveStatus').textContent='Project saved / unchanged';}
 function preferences(){
  const values=Rig.settings();try{Rig.validateSettings(values);}catch{return;}
  try{localStorage.setItem('rig-planner-preferences-v1',JSON.stringify(values));}
  catch{$('saveStatus').textContent=dirty?'Unsaved analysis · browser preferences unavailable':'Browser preferences unavailable; Save project works.';}
  if(bridge&&!stopped)preferenceWrites=preferenceWrites.then(()=>api('preferences',{preferences:values})).catch(e=>{$('saveStatus').textContent='Preferences were not saved: '+e.message+'. Current analysis is retained.';});
 }
 try{const p=localStorage.getItem('rig-planner-preferences-v1');if(p){const s=JSON.parse(p);Rig.validateSettings(s);Rig.setSettings(s);}}catch{}
 for(const id of ['referenceMeters','spacingMeters','marginMeters','exclusionMeters','threshold','fine'])$(id).addEventListener('change',()=>{mark();preferences();renderSelection();});
 $('analysisNotes').addEventListener('input',mark);
 function working(img,meta){
  const w=meta.sourceWidth||img.naturalWidth,h=meta.sourceHeight||img.naturalHeight;
  if(meta.detected_format==='bmp'){const factor=Math.max(1,Math.ceil(Math.max(w,h)/2048));return {width:Math.ceil(w/factor),height:Math.ceil(h/factor)};}
  const scale=Math.min(1,2048/Math.max(img.naturalWidth,img.naturalHeight));return {width:Math.max(1,Math.round(img.naturalWidth*scale)),height:Math.max(1,Math.round(img.naturalHeight*scale))};
 }
 function decode(dataUrl){
  return new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>{if(!img.naturalWidth||!img.naturalHeight||Math.max(img.naturalWidth,img.naturalHeight)>25000||img.naturalWidth*img.naturalHeight>130000000){reject(Error('Image dimensions exceed supported bounds.'));return;}resolve(img);};img.onerror=()=>reject(Error('Image is incomplete, corrupt or not supported by this browser.'));img.src=dataUrl;});
 }
 async function projectText(){
  if(st.draft.length||st.mode==='cal'&&st.cal.length!==2)throw Error('Finish or cancel the current drawing before saving. Discard and Cancel remain available.');
  syncPendingSettings();
  const rig=pending?JSON.parse(JSON.stringify(pending.rig)):Rig.snapshot();
  const image=pending?pending.image:imageIdentity,notes=$('analysisNotes').value;
  if(pending?.legacy)throw Error('Reconnect and confirm the original screenshot before saving migrated markings.');
  if(rig.width&&!image)throw Error('Reselect the screenshot to establish its content fingerprint before saving.');
  const calculation=pending?pending.calculation:await Rig.receipt(image,rig,st.result);
  const p={schema:'rig-layout-project',version:2,image,rig,notes,calculation};const text=JSON.stringify(p,null,2);
  Rig.parse(text);return text;
 }
 async function save(){
  const rev=revision,text=await projectText();saveBlob(text,'rig-project.json','application/json');
  if(revision===rev)clean();return text;
 }
 function guard(){
  if(!dirty)return Promise.resolve(true);
  return new Promise(resolve=>{
   const dialog=$('unsavedDialog');
   const finish=value=>{dialog.close();for(const id of ['saveAndContinue','discardAndContinue','cancelReplace'])$(id).onclick=null;dialog.oncancel=null;resolve(value);};
   $('saveAndContinue').onclick=async()=>{try{await save();finish(true);}catch(e){status(e.message,'error');finish(false);}};
   $('discardAndContinue').onclick=()=>finish(true);
   $('cancelReplace').onclick=()=>finish(false);
   dialog.oncancel=e=>{e.preventDefault();finish(false);};dialog.showModal();
  });
 }
 function resetView(){suppress=true;resetResults();Object.assign(st,{img:null,base:null,w:0,h:0,mask:null,baseMask:null,legacyMask:false,bbox:null,maskArea:0,cal:[],poly:[],exclusions:[],draft:[],selectedExclusion:null,mode:'idle',source:{},scenario:'edge'});Editor.clearHistory();ctx.clearRect(0,0,canvas.width,canvas.height);setEnabled(false);setCalibrationLabels();renderSelection();suppress=false;imageIdentity=null;currentId=null;currentItem=null;$('sourceTag').textContent='No screenshot loaded';}
 async function openText(text,legacy=false){
  const candidate=Rig.parse(text,legacy); // Validate before changing the current session.
  userTouched=true;sourceEpoch++;
  if(!await guard())return false;
  const same=candidate.image&&imageIdentity&&sameImage(candidate.image,imageIdentity);
  clean();pending=candidate;suppress=true;Rig.setSettings(candidate.rig.settings);$('analysisNotes').value=candidate.notes;suppress=false;
  if(same){await restore();return true;}
  resetView();pending=candidate.rig.width?candidate:null;$('cancelRestore').hidden=!pending;
  clean();status(legacy?'Older rig markings selected. Choose the original image and explicitly confirm it; older files have no content fingerprint.':'Project opened. Reselect the original screenshot; content fingerprint and dimensions must match.');return true;
 }
 async function restore(){
  syncPendingSettings();
  const p=pending;if(!p)return;const unsaved=dirty;
  suppress=true;Rig.apply(p.rig);pending=null;$('cancelRestore').hidden=true;imageIdentity={...imageIdentity};suppress=false;
  if(unsaved||p.legacy)mark();else clean();
  if(p.legacy){status('Older rig markings imported. Inspect the image and save a new rig-only project.');}
  else status('Matching screenshot verified. Markings restored; saved calculations are recalculated from the preserved inputs.');
  if(p.calculation)makePlan(p.rig.selected||'edge');
 }
 function sameImage(a,b){return ['sha256','width','height','workingWidth','workingHeight'].every(k=>a[k]===b[k]);}
 async function acceptImage(img,meta,id=null,ticket=null){
  if(ticket!==null&&ticket!==sourceEpoch)return false;
  const dim=working(img,meta),identity={sha256:meta.sha256,width:meta.sourceWidth||img.naturalWidth,height:meta.sourceHeight||img.naturalHeight,workingWidth:dim.width,workingHeight:dim.height};
  if(pending){
   if(pending.rig.width!==dim.width||pending.rig.height!==dim.height)throw Error('Image dimensions do not match the saved markings. Current project is unchanged.');
   if(pending.image&&!sameImage(pending.image,identity))throw Error('Screenshot content fingerprint does not match this project. Reselect the original image.');
   if(pending.legacy&&!window.confirm('This older project has no image fingerprint. Confirm this is the original screenshot with the same view and dimensions. Import only its rig markings?'))return false;
  }else if(!await guard())return false;
  if(ticket!==null&&ticket!==sourceEpoch)return false;
  const restoring=!!pending;suppress=true;
  installImage(img,{...meta,workingWidth:dim.width,workingHeight:dim.height});
  imageIdentity=identity;currentId=id;currentItem=queue?.images.find(i=>i.id===id)||null;$('zoom').value='100';canvas.style.width='100%';
  if(!restoring)$('analysisNotes').value='';suppress=false;
  if(restoring)await restore();else{clean();detectPurple(null);status(st.mask?'Purple region detected. Inspect the mask and calibrate this image before calculating.':'No reliable purple region found. Choose a region or draw a manual boundary.','warn');}
  return true;
 }
 async function manualFile(file){
  if(!file)return false;if(file.size>80*1024*1024)throw Error('Manual image exceeds 80 MB. Use the Windows launcher for large BMP conversion.');
  userTouched=true;const ticket=++sourceEpoch;
  const bytes=await file.arrayBuffer(),mime=kind(new Uint8Array(bytes,0,Math.min(16,bytes.byteLength)));
  if(!mime)throw Error('Unrecognized image content.');
  const url=URL.createObjectURL(new Blob([bytes],{type:mime}));
  try{const img=await decode(url),sha256=await Rig.hash(bytes);return await acceptImage(img,{sha256,source_file_name:file.name,detected_format:mime.slice(6),sourceWidth:img.naturalWidth,sourceHeight:img.naturalHeight},null,ticket);}
  finally{URL.revokeObjectURL(url);}
 }
 async function action(fn){
  if(busy){status('Finish the current source action first.','warn');return;}
  busy=true;renderQueue();
  try{return await fn();}catch(e){status(e.message,'error');return false;}finally{busy=false;renderQueue();}
 }
 $('newFile').addEventListener('change',e=>{const f=e.target.files?.[0];if(f)action(()=>manualFile(f));e.target.value='';});
 $('saveProject').addEventListener('click',()=>action(save));
 $('openProject').addEventListener('click',()=>{if(!busy){userTouched=true;sourceEpoch++;$('projectFile').click();}});
 $('importRig').addEventListener('click',()=>{if(!busy){userTouched=true;sourceEpoch++;$('legacyFile').click();}});
 for(const [id,legacy] of [['projectFile',false],['legacyFile',true]])$(id).addEventListener('change',e=>{const file=e.target.files?.[0];if(file)action(async()=>{if(file.size>2*1024*1024)throw Error('Project exceeds 2 MB limit.');return openText(await file.text(),legacy);});e.target.value='';});
 $('cancelRestore').addEventListener('click',()=>action(async()=>{if(!await guard())return;pending=null;$('cancelRestore').hidden=true;resetView();clean();status('Project reopen canceled. Choose a screenshot.');}));
 $('zoom').addEventListener('input',()=>{canvas.style.width=$('zoom').value+'%';});
 $('fitImage').addEventListener('click',()=>{$('zoom').value='100';canvas.style.width='100%';});
 $('resetAnalysis').addEventListener('click',()=>action(async()=>{userTouched=true;sourceEpoch++;if(!st.img||!await guard())return false;if(!window.confirm('Reset this image analysis? Boundary, exclusions, calibration, layout, notes and undo history will be cleared. The screenshot and numeric preferences stay.'))return false;pending=null;$('cancelRestore').hidden=true;Editor.resetAnalysis();$('analysisNotes').value='';mark();return true;}));
 window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
 async function api(path,data){
  if(!bridge||stopped)throw Error('Local companion is not connected.');
  const options={method:data===undefined?'GET':'POST',headers:{'X-Rig-Token':bridge},credentials:'omit',cache:'no-store'};
  if(data!==undefined){options.headers['Content-Type']='application/json';options.body=JSON.stringify(data);}
  const response=await fetch('/api/'+path,options),value=await response.json();
  if(!response.ok)throw Error(value.error||'Local screenshot request refused.');return value;
 }
 function ready(){return queue?.images.filter(i=>i.state==='ready')||[];}
 function compare(a,b){return (a.mtimeNs-b.mtimeNs)||((a.name||'').toLowerCase()<(b.name||'').toLowerCase()?-1:(a.name||'').toLowerCase()>(b.name||'').toLowerCase()?1:0)||((a.name||'')<(b.name||'')?-1:(a.name||'')>(b.name||'')?1:0)||(a.id<b.id?-1:a.id>b.id?1:0);}
 function neighbor(direction){
  const items=ready(),index=items.findIndex(i=>i.id===currentId);
  if(index>=0)return items[index+direction]?.id||null;
  if(currentItem){const matches=items.filter(i=>direction<0?compare(i,currentItem)<0:compare(i,currentItem)>0);return (direction<0?matches.at(-1):matches[0])?.id||null;}
  return null;
 }
 function localTime(item){return Number.isFinite(item.mtimeNs)?new Date(item.mtimeNs/1000000).toLocaleString():'';}
 function renderQueue(){
  const live=!!bridge&&!stopped,available=live&&connected&&queue?.folderAvailable,items=ready();
  $('olderImage').disabled=busy||!available||!neighbor(-1);
  $('newerImage').disabled=busy||!available||!neighbor(1);
  $('loadLatest').disabled=busy||!available||!items.length;
  $('browseImages').disabled=busy;
  for(const id of ['refreshSource','changeFolder','stopCompanion'])$(id).disabled=busy||!live;
  const index=items.findIndex(i=>i.id===currentId),item=index>=0?items[index]:currentItem;
  $('imagePosition').textContent=index>=0?'Image '+(index+1)+' of '+items.length+' (oldest to newest) · '+item.name+' · '+localTime(item):currentId?'Current screenshot is no longer available in this folder; analysis is retained.':st.img?'Manually selected screenshot':items.length?'Choose a screenshot':'No completed image yet';
  if(queue){
   $('folderLabel').textContent=queue.folder||'Choose a screenshot folder';
   $('pendingCount').textContent=items.filter(i=>!i.loaded).length+' new · '+items.length+' ready';
   const files=queue.files||queue.images,checking=files.filter(i=>['candidate','pending'].includes(i.state)).length,bad=files.filter(i=>['rejected','unavailable'].includes(i.state)).length;
   $('queueNotice').textContent=(!connected?'Connection unavailable. Current work is retained. ':queue.notice||'')+(checking?' Checking '+checking+' image(s); the newest ready image may be older than a file still being written.':'')+(bad?' '+bad+' unavailable/unreadable image(s); see Browse.':'')+(!(queue.discoveryComplete??queue.scanComplete)?' Initial folder discovery is still in progress.':'');
  }
  if($('galleryDialog').open)renderGallery();
 }
 let galleryLimit=100;
 function renderGallery(){
  const list=$('galleryList'),items=[...(queue?.files||queue?.images||[])].reverse();list.replaceChildren();
  for(const item of items.slice(0,galleryLimit)){
   const row=document.createElement('li'),button=document.createElement('button'),label=document.createElement('span');
   button.textContent=item.name||'Screenshot';button.disabled=busy||!connected||item.state!=='ready';
   button.addEventListener('click',()=>action(async()=>{userTouched=true;$('galleryDialog').close();return loadQueued(item.id);}));
   label.textContent=' — '+item.state+' · '+localTime(item)+(item.detail?' · '+item.detail:'');row.append(button,label);list.appendChild(row);
  }
  $('gallerySummary').textContent=items.length?Math.min(galleryLimit,items.length)+' of '+items.length+' files; newest first.':'No companion files. You can choose a screenshot manually.';
  $('galleryMore').hidden=galleryLimit>=items.length;
 }
 $('browseImages').addEventListener('click',()=>{galleryLimit=100;renderGallery();$('galleryDialog').showModal();});
 $('galleryClose').addEventListener('click',()=>$('galleryDialog').close());
 $('galleryMore').addEventListener('click',()=>{galleryLimit+=100;renderGallery();});
 $('galleryManual').addEventListener('click',()=>{$('galleryDialog').close();$('newFile').click();});
 function installQueue(value){
  if(lastFolder!==null&&lastFolder!==value.folder){sourceEpoch++;currentId=null;currentItem=null;}
  queue=value;lastFolder=value.folder;connected=true;renderQueue();
 }
 async function poll(){
  if(!bridge||stopped||polling)return;polling=true;const folderTicket=folderEpoch,stateTicket=++stateEpoch;
  try{
   const first=await api('state');if(folderTicket!==folderEpoch||stateTicket!==stateEpoch||stopped)return;installQueue(first);
   if(!preferencesLoaded){
    preferencesLoaded=true;
    if(revision===0&&!pending&&!st.img&&!userTouched&&queue.preferences){Rig.validateSettings(queue.preferences);suppress=true;Rig.setSettings(queue.preferences);suppress=false;renderSelection();}
   }
   // Check newest candidates first. A failed/locked file never blocks its neighbors.
   for(const item of [...queue.images].reverse().filter(i=>i.state==='candidate').slice(0,2)){
    if(folderTicket!==folderEpoch||stopped)return;
    try{
     const data=await api('image?id='+encodeURIComponent(item.id));let img;
     try{img=await decode(data.dataUrl);}catch{if(folderTicket===folderEpoch)await api('validated',{id:item.id,ok:false});continue;}
     if(folderTicket!==folderEpoch||stopped)return;
     await api('validated',{id:item.id,ok:true,width:img.naturalWidth,height:img.naturalHeight});
    }catch(e){if(folderTicket===folderEpoch)$('queueNotice').textContent='Screenshot temporarily unavailable; will retry. '+e.message;}
   }
   const value=await api('state');if(folderTicket!==folderEpoch||stateTicket!==stateEpoch||stopped)return;installQueue(value);
   $('connectionStatus').textContent='Windows-local screenshot companion';
   const newest=ready().at(-1),candidateAfter=newest&&queue.images.some(i=>i.state==='candidate'&&compare(i,newest)>0);
   if(!autoOpened&&!userTouched&&!pending&&!st.img&&!dirty&&!busy&&newest&&!candidateAfter&&(queue.discoveryComplete??queue.scanComplete)){
    await action(async()=>{if(!userTouched&&!pending&&!st.img){const ok=await loadQueued(newest.id,true);if(ok)autoOpened=true;}});
   }
  }catch(e){if(stopped)return;connected=false;$('connectionStatus').textContent='Companion unavailable';renderQueue();$('queueNotice').textContent=e.message+' Current work is retained. Use Refresh to retry.';}
  finally{polling=false;if(!stopped)setTimeout(poll,1200);}
 }
 async function loadQueued(id,automatic=false){
  if(!id)return false;if(!automatic)userTouched=true;
  if(id===currentId&&st.img&&!pending)return true;
  const ticket=++sourceEpoch,folderTicket=folderEpoch;
  const data=await api('image?id='+encodeURIComponent(id)),img=await decode(data.dataUrl);
  if(ticket!==sourceEpoch||folderTicket!==folderEpoch||stopped||automatic&&(userTouched||pending||st.img||dirty))return false;
  const ok=await acceptImage(img,{sha256:data.sha256,detected_format:data.format,sourceWidth:data.sourceWidth||img.naturalWidth,sourceHeight:data.sourceHeight||img.naturalHeight,source_file_name:queue?.images.find(i=>i.id===id)?.name},id,ticket);
  if(ok){const value=await api('loaded',{id});if(folderTicket===folderEpoch)installQueue(value);}return ok;
 }
 $('olderImage').addEventListener('click',()=>action(()=>loadQueued(neighbor(-1))));
 $('newerImage').addEventListener('click',()=>action(()=>loadQueued(neighbor(1))));
 $('loadLatest').addEventListener('click',()=>action(()=>loadQueued(ready().at(-1)?.id)));
 $('refreshSource').addEventListener('click',()=>action(async()=>{const ticket=++stateEpoch,value=await api('refresh',{});if(ticket===stateEpoch)installQueue(value);$('connectionStatus').textContent='Windows-local screenshot companion';}));
 $('changeFolder').addEventListener('click',()=>action(async()=>{userTouched=true;sourceEpoch++;folderEpoch++;stateEpoch++;const value=await api('change-folder',{});installQueue(value);}));
 $('stopCompanion').addEventListener('click',()=>action(async()=>{if(!await guard())return false;sourceEpoch++;folderEpoch++;await api('stop',{});stopped=true;connected=false;$('connectionStatus').textContent='Companion stopped — current image remains available';return true;}));

 if(location.protocol==='http:'&&location.hostname==='127.0.0.1'){
  let token=new URLSearchParams(location.hash.slice(1)).get('rig-token');
  try{token=token||sessionStorage.getItem('rig-companion-token');}catch{}
  if(token&&/^[A-Za-z0-9_-]{32,128}$/.test(token)){
   bridge=token;
   try{sessionStorage.setItem('rig-companion-token',token);history.replaceState(null,'',location.pathname);}catch{}
   poll();
  }
 }
 if(EMBED_IMAGE)action(async()=>{
  const img=await decode(EMBED_IMAGE),meta=EMBED_META||{};
  if(!/^[a-f0-9]{64}$/.test(meta.sha256||''))throw Error('This embedded page has no source fingerprint. Reselect the original screenshot to begin.');
  await acceptImage(img,{...meta,sourceWidth:meta.decoded_dimensions?.[0]||img.naturalWidth,sourceHeight:meta.decoded_dimensions?.[1]||img.naturalHeight});
 });
 renderSelection();
 return {projectText,openText,manualFile,acceptImage,guard,save,decode,working,loadQueued,poll,action,ready,neighbor,installQueue,get currentId(){return currentId;},get dirty(){return dirty;},get pending(){return pending;},get identity(){return imageIdentity;}};
})();
