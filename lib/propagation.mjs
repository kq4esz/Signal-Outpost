import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { makeOrbit, observerPoint, positionAt } from './iss-orbit.mjs';
import { bandFor, locatorPoint, maidenhead, distanceKm } from './propagation-bands.mjs';

const MINUTE=60000,HOUR=60*MINUTE,DAY=24*HOUR;
const AGENT='SignalOutpost/0.15 (https://github.com/kq4esz/Signal-Outpost)';
const SOURCES={
  scales:{name:'NOAA SWPC scales',url:'https://services.swpc.noaa.gov/products/noaa-scales.json',ttl:5*MINUTE},
  kp:{name:'NOAA planetary Kp',url:'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json',ttl:5*MINUTE},
  flux:{name:'NOAA 10.7 cm solar flux',url:'https://services.swpc.noaa.gov/json/f107_cm_flux.json',ttl:30*MINUTE},
  bands:{name:'HAMQSL / N0NBH',url:'https://www.hamqsl.com/solarxml.php',ttl:HOUR},
  orbit:{name:'CelesTrak ISS GP elements',url:'https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=JSON',ttl:2*HOUR}
};
const plain=(value,max=240)=>String(value??'').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,max).trim();
const number=value=>value===null||value===undefined||String(value).trim()===''||!Number.isFinite(Number(value))?null:Number(value);
const utc=value=>{const text=String(value||'');const time=Date.parse(text+(/Z$|[+-]\d\d:\d\d$/.test(text)?'':'Z'));return Number.isFinite(time)?time:null;};
const xmlText=value=>plain(String(value||'').replace(/&(?:amp|lt|gt|quot|apos);|&#(?:x[\da-f]+|\d+);/gi,entity=>{
  const known={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"};if(known[entity])return known[entity];
  const code=entity[2].toLowerCase()==='x'?parseInt(entity.slice(3,-1),16):parseInt(entity.slice(2,-1),10);return code>0&&code<=0x10ffff?String.fromCodePoint(code):'';
}));
function attributes(text){const result={};for(const match of text.matchAll(/([\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+))/g))result[match[1]]=xmlText(match[2]??match[3]??match[4]);return result;}
function safeXml(text){if(/<!DOCTYPE|<!ENTITY/i.test(text))throw new Error('Unsupported XML document.');return text;}
function bandConditions(text){
  safeXml(text);const tag=name=>xmlText(text.match(new RegExp(`<${name}\\b[^>]*>([^<]*)</${name}>`,'i'))?.[1]);
  const bands=[];for(const match of text.matchAll(/<band\b([^>]*)>([^<]*)<\/band>/gi)){const attrs=attributes(match[1]);if(['day','night'].includes(attrs.time))bands.push({name:plain(attrs.name,30),period:attrs.time,condition:xmlText(match[2])});}
  if(!bands.length)throw new Error('Band outlook feed contains no band conditions.');
  const updated=tag('updated'),parsed=Date.parse(updated.replace(/(\d{4})\s+(\d{2})(\d{2})\s+GMT/,'$1 $2:$3 GMT'));
  return {updated,observedAt:Number.isFinite(parsed)?parsed:null,bands,solarWind:number(tag('solarwind')),bz:number(tag('magneticfield')),xray:tag('xray'),sunspots:number(tag('sunspots')),aIndex:number(tag('aindex')),noise:tag('signalnoise'),geomagnetic:tag('geomagfield')};
}
function normalizeFeed(name,text){
  if(name==='bands')return bandConditions(text);
  const data=JSON.parse(text);
  if(name==='orbit'){const elements=data.find(row=>Number(row.NORAD_CAT_ID)===25544);makeOrbit(elements);return elements;}
  if(name==='scales'){
    const row=data['0'];if(!row||!['R','S','G'].some(key=>number(row[key]?.Scale)!==null))throw new Error('NOAA scales are unavailable.');
    return {observedAt:utc(`${row.DateStamp}T${row.TimeStamp}`),R:number(row.R?.Scale),S:number(row.S?.Scale),G:number(row.G?.Scale)};
  }
  let rows=data;
  if(Array.isArray(data?.[0])){const [header,...values]=data;rows=values.map(values=>Object.fromEntries(header.map((key,index)=>[key,values[index]])));}
  if(!Array.isArray(rows))throw new Error('Unexpected NOAA feed format.');
  const valid=rows.filter(row=>{const value=number(name==='kp'?row.Kp:row.flux);return value!==null&&(name==='kp'?value>=0&&value<=9:value>0&&value<10000)&&utc(row.time_tag)!==null;}).sort((a,b)=>utc(b.time_tag)-utc(a.time_tag));
  if(!valid.length)throw new Error('NOAA observations are unavailable.');
  const row=valid[0];return name==='kp'?{value:number(row.Kp),observedAt:utc(row.time_tag),history:valid.slice(0,24).reverse().map(row=>({time:utc(row.time_tag),value:number(row.Kp)}))}:{value:number(row.flux),observedAt:utc(row.time_tag)};
}
async function fetchText(url,max=2000000){
  const response=await fetch(url,{headers:{'User-Agent':AGENT,Accept:'application/json, application/xml, text/xml, text/plain'},signal:AbortSignal.timeout(18000)});
  if(!response.ok)throw new Error(`Source returned HTTP ${response.status}.`);
  if(Number(response.headers.get('content-length'))>max)throw new Error('Source response is too large.');
  const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>max)throw new Error('Source response is too large.');chunks.push(chunk);}return Buffer.concat(chunks).toString('utf8');
}
function read(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fallback;}}
function observerKey(prefs){return JSON.stringify([prefs.observer?.latitude,prefs.observer?.longitude,prefs.observer?.altitude,prefs.minElevation,prefs.days]);}

export class Propagation {
  constructor(dataDir){
    this.prefsFile=path.join(dataDir,'propagation.json');this.cacheFile=path.join(dataDir,'propagation-feeds.json');
    this.prefs={observer:null,minElevation:10,days:3,callsign:'',direction:'both',...read(this.prefsFile,{})};
    this.cache=read(this.cacheFile,{});this.pending=new Map();this.attempts={};this.passCache=new Map();this.geocodeCache=new Map();
  }
  preferences(){return {...this.prefs,observerKey:observerKey(this.prefs)};}
  savePreferences(input){
    const next={observer:null,minElevation:number(input.minElevation),days:number(input.days),callsign:plain(input.callsign,24).toUpperCase(),direction:input.direction};
    if(next.minElevation===null||next.minElevation<0||next.minElevation>80||![3,5,7].includes(next.days))throw new Error('Choose an elevation from 0–80 degrees and a prediction window of 3, 5 or 7 days.');
    if(next.callsign&&!/^[A-Z0-9/]{3,24}$/.test(next.callsign))throw new Error('Enter a valid station callsign, or leave it blank to use your saved grid.');
    if(!['both','rx','tx'].includes(next.direction))throw new Error('Choose a report direction.');
    if(input.observer){const {latitude,longitude,altitude}=input.observer;
      if([latitude,longitude,altitude].some(value=>typeof value!=='number'||!Number.isFinite(value))||Math.abs(latitude)>90||Math.abs(longitude)>180||altitude< -500||altitude>9000)throw new Error('Enter valid latitude, longitude and height above sea level in metres.');
      next.observer={latitude,longitude,altitude,label:plain(input.observer.label,160)||`${latitude.toFixed(4)}, ${longitude.toFixed(4)}`,grid:maidenhead(latitude,longitude)};
    }
    fs.writeFileSync(this.prefsFile,JSON.stringify(next,null,2));this.prefs=next;return this.preferences();
  }
  saveCache(){try{fs.writeFileSync(this.cacheFile,JSON.stringify(this.cache));}catch{/* Live data remains usable when the cache cannot be saved. */}}
  async feed(name){
    const source=SOURCES[name],now=Date.now(),saved=this.cache[name];
    const result=(entry,warning)=>{const observedAt=entry?.data?.observedAt,limit=name==='scales'?2*HOUR:name==='kp'?8*HOUR:name==='flux'?3*DAY:6*HOUR,aging=observedAt&&now-observedAt>limit;return {data:entry?.data||null,fetchedAt:entry?.fetchedAt||null,source:source.name,url:source.url,stale:!entry||now-entry.fetchedAt>source.ttl||Boolean(aging),warning:warning||(aging?'The latest source observation is older than expected.':null),nextRefreshAt:(entry?.fetchedAt||now)+source.ttl};};
    if(saved?.data&&now-saved.fetchedAt<source.ttl)return result(saved);
    if(this.pending.has(name))return this.pending.get(name);
    if(now-(this.attempts[name]?.time||0)<MINUTE)return result(saved,this.attempts[name].error||'Source refresh is pending.');
    this.attempts[name]={time:now};
    const promise=(async()=>{try{const data=normalizeFeed(name,await fetchText(source.url));const entry={data,fetchedAt:Date.now()};this.cache[name]=entry;this.saveCache();return result(entry);}
      catch(error){this.attempts[name].error=error.message;return result(saved,error.message);}})().finally(()=>this.pending.delete(name));
    this.pending.set(name,promise);return promise;
  }
  async weather(){const names=['scales','kp','flux','bands'];const values=await Promise.all(names.map(name=>this.feed(name)));return {asOf:Date.now(),feeds:Object.fromEntries(names.map((name,index)=>[name,values[index]]))};}
  async geocode(input){
    const query=plain(input.query,240);if(query.length<3)throw new Error('Enter an address, town or postal code.');
    if(this.geocodeCache.has(query))return {results:this.geocodeCache.get(query)};
    if(Date.now()-(this.geocodeAt||0)<1100)throw new Error('Please wait a moment before searching another address.');
    this.geocodeAt=Date.now();
    const url=new URL(process.env.SIGNAL_OUTPOST_GEOCODER_URL||'https://nominatim.openstreetmap.org/search');
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Invalid geocoder configuration.');
    url.searchParams.set('q',query);url.searchParams.set('format','jsonv2');url.searchParams.set('limit','5');url.searchParams.set('addressdetails','0');
    const rows=JSON.parse(await fetchText(url,500000));if(!Array.isArray(rows))throw new Error('Address service returned an unexpected response.');
    const results=rows.map(row=>({latitude:number(row.lat),longitude:number(row.lon),label:plain(row.display_name,240)})).filter(row=>row.latitude!==null&&row.longitude!==null&&Math.abs(row.latitude)<=90&&Math.abs(row.longitude)<=180);
    this.geocodeCache.set(query,results);if(this.geocodeCache.size>20)this.geocodeCache.delete(this.geocodeCache.keys().next().value);
    return {results};
  }
  async passes(elements,prefs){
    const key=elements.EPOCH+observerKey(prefs),now=Date.now(),saved=this.passCache.get(key);
    if(saved&&now-saved.computedAt<5*MINUTE)return saved;
    if(this.passPending){if(this.passPending.key===key)return this.passPending.promise;throw new Error('Pass predictions are busy. Refresh again in a moment.');}
    const promise=new Promise((resolve,reject)=>{
      const worker=new Worker(new URL('./iss-worker.mjs',import.meta.url),{workerData:{elements,observer:prefs.observer,minElevation:prefs.minElevation,days:prefs.days,now}});
      let settled=false;const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
      const timer=setTimeout(()=>{void worker.terminate();finish(new Error('Pass prediction timed out. Try again.'));},20000);
      worker.once('message',result=>{if(result.error)return finish(new Error(result.error));const value={passes:result.passes,computedAt:now,until:now+prefs.days*DAY};this.passCache.set(key,value);if(this.passCache.size>4)this.passCache.delete(this.passCache.keys().next().value);finish(null,value);});
      worker.once('error',error=>finish(error));worker.once('exit',code=>{if(!settled)finish(new Error(`Pass prediction worker ended (${code}).`));});
    }).finally(()=>{if(this.passPending?.key===key)this.passPending=null;});
    this.passPending={key,promise};return promise;
  }
  async iss(includePasses=false){
    const prefs=this.preferences(),feed=await this.feed('orbit');if(!feed.data)throw new Error(`ISS orbital data unavailable. ${feed.warning||''}`);
    const now=Date.now(),{orbit,epoch}=makeOrbit(feed.data),age=now-epoch;
    if(age>7*DAY||age< -DAY)throw new Error('ISS orbital elements are outside the usable date range. Refresh the source before predicting passes.');
    const observer=observerPoint(prefs.observer),position=positionAt(orbit,now,observer),track=[];
    for(let time=now-15*MINUTE;time<=now+100*MINUTE;time+=30000){const point=positionAt(orbit,time);track.push([point.latitude,point.longitude,time]);}
    let predictions=null,predictionError=null;
    if(includePasses&&prefs.observer){try{predictions=await this.passes(feed.data,prefs);}catch(error){predictionError=error.message;}}
    return {asOf:now,position,track,observer:prefs.observer,observerKey:prefs.observerKey,minElevation:prefs.minElevation,days:prefs.days,predictions,predictionError,epoch,source:feed.source,sourceUrl:feed.url,fetchedAt:feed.fetchedAt,stale:feed.stale||age>3*DAY,warning:[feed.warning,age>3*DAY?'Orbital elements are over three days old; pass times may drift.':null].filter(Boolean).join(' ')||null};
  }
  activityQuery(){const {callsign,direction,observer}=this.prefs;const grid=observer?.grid?.slice(0,4).toUpperCase();if(!callsign&&!grid)throw new Error('Save a callsign or observer location to load FT8 / FT4 activity reports.');return {callsign:callsign||grid,grid:!callsign,direction};}
  async activity(){
    const query=this.activityQuery(),key=JSON.stringify(query),saved=this.cache.activity,now=Date.now();
    if(saved?.key===key&&now-saved.fetchedAt<5*MINUTE)return {...saved,query,nextRefreshAt:saved.fetchedAt+5*MINUTE,stale:false};
    if(this.pending.has('activity'))throw new Error('A PSK Reporter request is already running.');
    const last=Math.max(this.cache.pskAttemptAt||0,saved?.fetchedAt||0);
    if(now-last<5*MINUTE){if(saved?.key===key)return {...saved,query,nextRefreshAt:last+5*MINUTE,stale:true,warning:'Showing saved reports until the next allowed refresh.'};throw new Error(`PSK Reporter refresh is limited to once every five minutes. Try after ${new Date(last+5*MINUTE).toISOString().slice(11,19)} UTC.`);}
    const promise=(async()=>{
      this.cache.pskAttemptAt=now;this.saveCache();
      try{
        const url=new URL('https://retrieve.pskreporter.info/query');const parameter=query.grid?'receiverCallsign':query.direction==='rx'?'receiverCallsign':query.direction==='tx'?'senderCallsign':'callsign';
        url.searchParams.set(parameter,query.callsign);if(query.grid)url.searchParams.set('modify','grid');
        url.searchParams.set('flowStartSeconds','-900');url.searchParams.set('rptlimit','500');url.searchParams.set('rronly','1');url.searchParams.set('noactive','1');
        const text=safeXml(await fetchText(url,3000000));if(!/<(?:receptionReports|pskreporter)\b/i.test(text))throw new Error('PSK Reporter returned an unexpected document.');
        const reports=[];for(const match of text.matchAll(/<receptionReport\b([^>]*)\/?\s*>/gi)){
          const row=attributes(match[1]),mode=plain(row.mode,12).toUpperCase(),frequency=number(row.frequency),seconds=number(row.flowStartSeconds);
          if(!['FT8','FT4'].includes(mode)||frequency===null||frequency<=0||seconds===null||seconds*1000<now-20*MINUTE||seconds*1000>now+MINUTE)continue;
          const from=locatorPoint(row.senderLocator),to=locatorPoint(row.receiverLocator);
          reports.push({sender:plain(row.senderCallsign,24),receiver:plain(row.receiverCallsign,24),senderGrid:plain(row.senderLocator,8),receiverGrid:plain(row.receiverLocator,8),from,to,frequency,mode,snr:number(row.sNR),timestamp:seconds*1000,band:bandFor(frequency),distanceKm:from&&to?Math.round(distanceKm(from,to)):null});if(reports.length>=500)break;
        }
        const unique=[...new Map(reports.map(row=>[[row.sender,row.receiver,row.frequency,row.timestamp,row.mode].join(':'),row])).values()].sort((a,b)=>b.timestamp-a.timestamp);
        const result={key,query,reports:unique,fetchedAt:Date.now(),source:'PSK Reporter',sourceUrl:'https://pskreporter.info/pskmap.html',limited:reports.length>=500};this.cache.activity=result;this.saveCache();return {...result,nextRefreshAt:result.fetchedAt+5*MINUTE,stale:false};
      }catch(error){if(saved?.key===key)return {...saved,query,nextRefreshAt:now+5*MINUTE,stale:true,warning:error.message};throw error;}
    })().finally(()=>this.pending.delete('activity'));this.pending.set('activity',promise);return promise;
  }
}
