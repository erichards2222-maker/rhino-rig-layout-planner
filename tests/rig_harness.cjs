'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const {test} = require('node:test');

function load({storageDenied=false,network=null}={}) {
  const root=path.join(__dirname,'..'), html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  const elements=new Map(), exports=[], urls=new Map(), timers=new Set();
  let token=0;
  function element(tag='div') {
    const events=new Map(), e={tagName:tag.toUpperCase(),value:'',checked:false,disabled:false,hidden:false,textContent:'',style:{},children:[],open:false,
      addEventListener(name,fn){if(!events.has(name))events.set(name,[]);events.get(name).push(fn);},
      async fire(name,detail={}){for(const fn of events.get(name)||[])await fn({target:e,preventDefault(){},...detail});},
      click(x=0,y=0){if(tag==='a'){exports.push({name:e.download,blob:urls.get(e.href)});return;}if(e.onclick)return e.onclick({target:e});return e.fire('click',{clientX:x,clientY:y});},
      appendChild(child){e.children.push(child);return child;},append(...children){e.children.push(...children);},
      replaceChildren(...children){e.children=children;},remove(){},
      getBoundingClientRect(){return {left:0,top:0,width:e.width||120,height:e.height||100};},
      showModal(){e.open=true;},close(){e.open=false;},
      toBlob(fn,type){fn(new Blob(['synthetic encoded output'],{type}));}
    };
    let data=null;const ops=[];
    const ctx={ops,
      fillRect(...args){ops.push(['fillRect',...args]);},fillText(...args){ops.push(['fillText',...args]);},
      drawImage(img,...args){ops.push(['drawImage',img,...args]);if(img.__pixels)data=img.__pixels;else if(img._data)data=img._data();},
      clearRect(){ops.length=0;},putImageData(image){data=image.data;},createImageData(w,h){return {data:new Uint8ClampedArray(w*h*4)};},
      getImageData(){return {data:data||new Uint8ClampedArray((e.width||120)*(e.height||100)*4)};},
      beginPath(){ops.push(['beginPath']);},arc(...args){ops.push(['arc',...args]);},moveTo(){},lineTo(){},stroke(){},fill(){},closePath(){},save(){},restore(){},setLineDash(){}
    };
    e.getContext=()=>ctx;e._data=()=>data;
    return e;
  }
  function el(id){if(!elements.has(id))elements.set(id,element(id==='imageCanvas'?'canvas':'div'));return elements.get(id);}
  for(const match of html.matchAll(/<input\b[^>]*>/g)){const raw=match[0],id=/\bid="([^"]+)"/.exec(raw)?.[1];if(id){el(id).value=/\bvalue="([^"]*)"/.exec(raw)?.[1]||'';el(id).checked=/\bchecked\b/.test(raw);}}
  el('analysisNotes').value='';
  const document={getElementById:el,createElement:element,body:element('body')};
  const setTimer=(fn,ms)=>{const t=setTimeout(()=>{timers.delete(t);fn();},ms);timers.add(t);return t;};
  const context={document,window:{addEventListener(){},confirm(){return true;},print(){}},location:{protocol:'file:',hostname:'',hash:''},
    localStorage:{getItem(){if(storageDenied)throw Error('Denied');return null;},setItem(){if(storageDenied)throw Error('Quota');}},
    crypto:webcrypto,TextEncoder,TextDecoder,Uint8Array,Uint8ClampedArray,ArrayBuffer,Blob,Buffer,URLSearchParams,
    URL:{createObjectURL(blob){const id='blob:test-'+(++token);urls.set(id,blob);return id;},revokeObjectURL(id){urls.delete(id);}},
    btoa:s=>Buffer.from(s,'binary').toString('base64'),atob:s=>Buffer.from(s,'base64').toString('binary'),
    setTimeout:setTimer,clearTimeout,console,
  };
  if(network){
    context.location={protocol:'http:',hostname:'127.0.0.1',hash:'#rig-token='+'a'.repeat(43),pathname:'/'};
    context.history={replaceState(){}};context.sessionStorage={getItem(){return null;},setItem(){}};
    context.fetch=network;
    context.Image=class{constructor(){this.naturalWidth=24;this.naturalHeight=24;}set src(value){Promise.resolve().then(()=>value==='corrupt'?this.onerror():this.onload());}};
  }
  const scripts=[...html.matchAll(/<script>\s*([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
  const api=vm.runInNewContext(scripts+'\n;({App,Rig,st,installImage,makePlan,resetResults,metersPerPixel,candidateCsv,exportCanvas,renderSelection,renderTable,draw,insetCheck,layoutSolver,selectedLayout,Editor})',context);
  return {...api,el,exports,context,close(){for(const t of timers)clearTimeout(t);}};
}
const clone=x=>JSON.parse(JSON.stringify(x));
async function wait(fn){for(let i=0;i<300;i++){if(fn())return;await new Promise(r=>setTimeout(r,4));}throw Error('Test condition did not complete');}
function image(w=120,h=100){const data=new Uint8ClampedArray(w*h*4);for(let i=0;i<w*h;i++)data.set([140,40,130,255],i*4);return {naturalWidth:w,naturalHeight:h,__pixels:data};}
const meta=(hash='a')=>({sha256:hash.repeat(64),sourceWidth:120,sourceHeight:100,detected_format:'png'});
async function prepare(api){
  await api.App.acceptImage(image(),meta());
  api.Rig.setSettings({...clone(api.Rig.defaults),referenceMeters:20,spacingMeters:30,marginMeters:20,fine:false});
  await api.el('calibrate').click();await api.el('imageCanvas').click(30,30);await api.el('imageCanvas').click(50,30);
  api.makePlan();await wait(()=>!!api.st.result);
}
async function discard(api,promise){await wait(()=>api.el('unsavedDialog').open);await api.el('discardAndContinue').click();return promise;}


module.exports={load,clone,wait,image,meta,prepare,discard};
