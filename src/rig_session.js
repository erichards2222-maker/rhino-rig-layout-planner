const Rig = (() => {
 const limits={referenceMeters:[1,50],spacingMeters:[30,300],marginMeters:[0,50],exclusionMeters:[1,100],threshold:[8,32]};
 const defaults={referenceMeters:12.24,spacingMeters:80,marginMeters:5,exclusionMeters:12,threshold:16,fine:true};
 const plain=o=>!!o&&typeof o==='object'&&!Array.isArray(o);
 function keys(o,allowed){if(!plain(o)||Object.keys(o).some(k=>!allowed.includes(k)))throw Error('Unrecognized project field.');}
 function settings(){const values={fine:$('fine').checked};for(const key of Object.keys(limits))values[key]=Number($(key).value);return values;}
 function validateSettings(s){
  keys(s,[...Object.keys(limits),'fine']);if(typeof s.fine!=='boolean')throw Error('Invalid search setting.');
  for(const [key,[lo,hi]] of Object.entries(limits))if(!Number.isFinite(s[key])||s[key]<lo||s[key]>hi)throw Error('Invalid rig setting: '+key);
 }
 function setSettings(s){validateSettings(s);for(const [k,v] of Object.entries(s)){if(k==='fine')$(k).checked=v;else $(k).value=v;}$('thresholdLabel').textContent=s.threshold;}
 function pack(mask){if(!mask)return null;const bytes=new Uint8Array(Math.ceil(mask.length/8));mask.forEach((v,i)=>{if(v)bytes[i>>3]|=1<<(i&7);});let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);}
 function unpack(text,width,height){if(text===null)return null;const bytes=atob(text),mask=new Uint8Array(width*height);for(let i=0;i<mask.length;i++)mask[i]=(bytes.charCodeAt(i>>3)>>(i&7))&1;return mask;}
 function snapshot(){return {width:st.img?st.w:0,height:st.img?st.h:0,settings:settings(),baseMask:pack(st.baseMask),mask:pack(st.mask),legacyMask:!!st.legacyMask,cal:st.cal.map(p=>({...p})),poly:st.poly.map(p=>({...p})),exclusions:JSON.parse(JSON.stringify(st.exclusions)),selected:st.scenario};}
 function validMask(text,r){if(text!==null&&(typeof text!=='string'||!r.width||text.length!==4*Math.ceil(Math.ceil(r.width*r.height/8)/3)||!/^[a-zA-Z0-9+/]*={0,2}$/.test(text)||atob(text).length!==Math.ceil(r.width*r.height/8)))throw Error('Invalid saved rig mask.');}
 function validate(r,version=2){
  keys(r,version===1?['width','height','settings','mask','cal','poly','exclusions','selected']:['width','height','settings','baseMask','mask','legacyMask','cal','poly','exclusions','selected']);
  if(!Number.isInteger(r.width)||!Number.isInteger(r.height)||r.width<0||r.height<0||r.width>2048||r.height>2048||((r.width===0)!==(r.height===0)))throw Error('Invalid saved rig dimensions.');
  validateSettings(r.settings);
  if(r.selected!==undefined&&!['edge','safe'].includes(r.selected))throw Error('Invalid selected layout.');
  validMask(r.mask,r);
  if(version===2){validMask(r.baseMask,r);if(typeof r.legacyMask!=='boolean')throw Error('Invalid mask migration flag.');if((r.baseMask===null)!==(r.mask===null))throw Error('Missing base or usable mask.');}
  for(const [key,max] of [['cal',2],['poly',version===1||r.legacyMask?10000:512]]){
   if(!Array.isArray(r[key])||r[key].length>max||(!r.width&&r[key].length))throw Error('Invalid rig points.');
   for(const p of r[key]){keys(p,['x','y']);if(!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.x>r.width||p.y<0||p.y>r.height)throw Error('Invalid saved rig geometry.');}
  }
  if(!Array.isArray(r.exclusions)||r.exclusions.length>(version===1?10000:128)||!r.width&&r.exclusions.length)throw Error('Invalid exclusion count.');
  if(version===1){for(const p of r.exclusions){keys(p,['x','y','radius']);if(!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.x>r.width||p.y<0||p.y>r.height||!Number.isFinite(p.radius)||p.radius<=0||p.radius>20000)throw Error('Invalid older exclusion geometry.');}}
  else{const ids=new Set();for(const p of r.exclusions){keys(p,p.type==='circle'?['id','type','x','y','radius']:['id','type','kind','points','tolerancePx']);if(p.type==='polygon')for(const v of p.points||[])keys(v,['x','y']);Editor.validateShape(p);if(ids.has(p.id))throw Error('Duplicate exclusion identity.');ids.add(p.id);}if(r.baseMask){const base=unpack(r.baseMask,r.width,r.height),mask=unpack(r.mask,r.width,r.height);for(let i=0;i<mask.length;i++)if(mask[i]&&!base[i])throw Error('Usable mask exceeds its base boundary.');const expected=Editor.effectiveMask(base,r.width,r.height,r.exclusions);for(let i=0;i<mask.length;i++)if(mask[i]!==expected[i])throw Error('Saved exclusions contradict the usable mask.');}}
  if(r.cal.length===2){const pixels=Math.hypot(r.cal[0].x-r.cal[1].x,r.cal[0].y-r.cal[1].y),mpp=r.settings.referenceMeters/pixels;if(pixels<8||mpp<.005||mpp>10)throw Error('Invalid calibration scale.');}
 }
 function migrate(r){validate(r,1);if(r.exclusions.length>128)throw Error('Older project has more than 128 circles; retain it and simplify before migration.');const out=JSON.parse(JSON.stringify(r));out.baseMask=r.mask;out.legacyMask=!!r.mask;out.exclusions=r.exclusions.map((s,i)=>({id:'ex-legacy-'+(i+1),type:'circle',...s}));out.selected=out.selected||'edge';if(out.baseMask)out.mask=pack(Editor.effectiveMask(unpack(out.baseMask,out.width,out.height),out.width,out.height,out.exclusions));return out;}
 function apply(r){
  validate(r);if(st.w!==r.width||st.h!==r.height)throw Error('Image dimensions do not match saved markings.');
  resetResults();Editor.clearHistory();st.mask=null;st.bbox=null;st.maskArea=0;setSettings(r.settings);st.cal=r.cal.map(p=>({...p}));st.poly=r.poly.map(p=>({...p}));st.exclusions=JSON.parse(JSON.stringify(r.exclusions));st.baseMask=unpack(r.baseMask,st.w,st.h);st.legacyMask=r.legacyMask;st.selectedExclusion=null;st.draft=[];st.mode='idle';Editor.rebuild();
  st.scenario=r.selected||'edge';setCalibrationLabels();renderSelection();Editor.describeSelection();draw();
 }
 function parse(text,legacy=false){
  if(typeof text!=='string'||text.length>2*1024*1024)throw Error('Project exceeds 2 MB limit.');
  const p=JSON.parse(text,(k,v)=>{if(['__proto__','prototype','constructor'].includes(k))throw Error('Unsafe project key.');return v;});
  if(legacy){
   if(p?.schema!=='surface-mining-project'||p.version!==1||!p.rig)throw Error('No supported older rig markings found.');
   // Extract this one approved record; none of the surrounding workbook is retained.
   const rig=p.rig.baseMask!==undefined?(validate(p.rig),JSON.parse(JSON.stringify(p.rig))):migrate(p.rig);rig.selected=rig.selected||'edge';
   return {schema:'rig-layout-project',version:2,image:null,rig,notes:'',calculation:null,legacy:true};
  }
  keys(p,['schema','version','image','rig','notes','calculation']);
  if(p.schema!=='rig-layout-project'||![1,2].includes(p.version))throw Error('Unsupported rig project version. Current work is unchanged.');
  if(p.version===1){p.rig=migrate(p.rig);p.version=2;p.calculation=null;}else validate(p.rig);
  if(typeof p.notes!=='string'||p.notes.length>4000)throw Error('Invalid project notes.');
  if(p.image!==null){
   keys(p.image,['sha256','width','height','workingWidth','workingHeight']);
   if(!/^[a-f0-9]{64}$/.test(p.image.sha256)||!Number.isInteger(p.image.width)||!Number.isInteger(p.image.height)||p.image.width<=0||p.image.height<=0||Math.max(p.image.width,p.image.height)>25000||p.image.width*p.image.height>130000000||p.image.workingWidth!==p.rig.width||p.image.workingHeight!==p.rig.height)throw Error('Invalid screenshot identity or dimensions.');
  }else if(p.rig.width)throw Error('Saved markings require an image fingerprint. Use the explicit older-project import for old files.');
  if(p.calculation!==null){
   keys(p.calculation,['id','edgeCount','conservativeCount','complete']);
   if(!/^layout-[a-f0-9]{64}$/.test(p.calculation.id)||![p.calculation.edgeCount,p.calculation.conservativeCount].every(n=>Number.isInteger(n)&&n>=0&&n<=128)||typeof p.calculation.complete!=='boolean'||!p.rig.mask||p.rig.cal.length!==2)throw Error('Invalid calculation receipt.');
  }
  return p;
 }
 async function hash(bytes){const out=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(out),b=>b.toString(16).padStart(2,'0')).join('');}
 async function receipt(image,rig,result){
  if(!result)return null;
  const id=await hash(new TextEncoder().encode(JSON.stringify({image,rig,edge:result.edge,safe:result.safe})));
  return {id:'layout-'+id,edgeCount:result.edge.points.length,conservativeCount:result.safe.points.length,complete:result.edge.complete&&result.safe.complete};
 }
 return {settings,defaults,validateSettings,setSettings,snapshot,validate,apply,parse,hash,receipt,pack,unpack,migrate};
})();
