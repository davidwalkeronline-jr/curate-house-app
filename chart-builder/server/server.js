// Chord Chart Builder server.
// Serves the builder page and turns YouTube or Spotify links into audio the browser can analyze
// (yt-dlp; Spotify tracks are matched to the same song on YouTube). Chords and lyrics are worked
// out on the user's device; transcribe.py (faster-whisper) is only a fallback for browsers that
// cannot run the speech model.
'use strict';
const http=require('http');
const {spawn}=require('child_process');
const fs=require('fs');
const os=require('os');
const path=require('path');

const PORT=+process.env.PORT||8787;
const YTDLP=process.env.YTDLP_PATH||'yt-dlp';
const FFMPEG=process.env.FFMPEG_PATH||'ffmpeg';
const COOKIES=process.env.YTDLP_COOKIES||'';
const MAX_SECONDS=+process.env.MAX_DURATION||900;
const ORIGINS=(process.env.ALLOWED_ORIGINS||'*').split(',').map(s=>s.trim()).filter(Boolean);
const STATIC_DIR=path.join(__dirname,'..');
const MAX_DOWNLOADS=+process.env.MAX_DOWNLOADS||3;
const RATE_LIMIT=+process.env.RATE_LIMIT||30; // API requests per IP per 10 minutes
const PYTHON=process.env.PYTHON_PATH||'python3';
const MAX_UPLOAD=(+process.env.MAX_UPLOAD_MB||40)*1048576;

const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.ttf':'font/ttf','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon','.json':'application/json'};

function kind(url){
  if(/^(https?:\/\/)?((www|m|music)\.)?(youtube\.com|youtu\.be)\//i.test(url))return 'youtube';
  if(/^(https?:\/\/)?open\.spotify\.com\/(intl-[a-z-]+\/)?track\/[A-Za-z0-9]+/i.test(url)||/^spotify:track:[A-Za-z0-9]+$/i.test(url))return 'spotify';
  return null;
}
function spotifyUrl(url){
  const m=/track[\/:]([A-Za-z0-9]+)/.exec(url);
  return m?'https://open.spotify.com/track/'+m[1]:null;
}
function decodeEntities(s){
  return s.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;|&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');
}
// Title and artist from the public track page: <title>Song - song and lyrics by Artist | Spotify</title>
function parseSpotifyPage(html){
  const t=/<title>([^<]*)<\/title>/i.exec(html);
  if(t){
    const m=/^(.*?) - (?:song|single)(?: and lyrics)? by (.*?) \| Spotify$/i.exec(decodeEntities(t[1]).trim());
    if(m)return {title:m[1].trim(),artist:m[2].trim()};
  }
  const og=/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i.exec(html);
  const desc=/<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i.exec(html);
  if(og)return {title:decodeEntities(og[1]),artist:desc?decodeEntities(desc[1]).split(' · ')[0]:''};
  return null;
}
const BROWSER_UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
// Spotify's track page is now an empty app shell for browsers, so read the public embed
// player's data first, then the page as link previews see it, then oEmbed (title only).
function parseSpotifyEmbed(html){
  const m=/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if(!m)return null;
  try{
    const e=JSON.parse(m[1]).props.pageProps.state.data.entity;
    const title=e.name||e.title;
    if(!title)return null;
    return {title,artist:(e.artists||[]).map(a=>a.name).filter(Boolean).join(', '),duration:e.duration?e.duration/1000:null};
  }catch(err){return null;}
}
async function getText(url,ua){
  const res=await fetch(url,{headers:{'User-Agent':ua,'Accept-Language':'en'}});
  return res.ok?res.text():'';
}
async function spotifyMeta(url){
  const page=spotifyUrl(url);
  if(!page)throw httpError(400,'That Spotify link does not point to a track.');
  const id=page.split('/').pop();
  let meta=null;
  try{meta=parseSpotifyEmbed(await getText('https://open.spotify.com/embed/track/'+id,BROWSER_UA));}catch(e){}
  if(!meta||!meta.artist){
    try{const p=parseSpotifyPage(await getText(page,'facebookexternalhit/1.1'));if(p&&p.title)meta=Object.assign({},meta,p);}catch(e){}
  }
  if(!meta){
    try{
      const o=await fetch('https://open.spotify.com/oembed?url='+encodeURIComponent(page));
      if(o.ok){const j=await o.json();if(j.title)meta={title:j.title,artist:''};}
    }catch(e){}
  }
  if(!meta||!meta.title)throw httpError(502,'Could not read that song from Spotify. Try the YouTube link for it instead.');
  return meta;
}
// Of a few YouTube search results, take the one closest in length to the Spotify track,
// skipping live, cover, karaoke and instrumental versions unless the track itself is one.
// Returns the candidates best first; the page falls back to the next one if YouTube refuses a download.
function rankMatches(entries,meta){
  const avoid=/\b(live|cover|karaoke|instrumental|lyric video|reaction|tutorial|sped up|slowed|remix)\b/i;
  const ok=entries.filter(e=>e&&e.id&&(!avoid.test(e.title||'')||avoid.test(meta.title)));
  const pool=ok.length?ok:entries.filter(e=>e&&e.id);
  if(!meta.duration)return pool;
  const close=pool.filter(e=>e.duration&&Math.abs(e.duration-meta.duration)<=15);
  return (close.length?close:pool).slice().sort((a,b)=>Math.abs((a.duration||1e9)-meta.duration)-Math.abs((b.duration||1e9)-meta.duration));
}
function pickMatch(entries,meta){return rankMatches(entries,meta)[0];}

function httpError(status,message){const e=new Error(message);e.status=status;return e;}
function ytdlpArgs(extra){return (COOKIES?['--cookies',COOKIES]:[]).concat(['--no-playlist','--no-warnings'],extra);}
function runJson(target,extra){
  return new Promise((resolve,reject)=>{
    const p=spawn(YTDLP,ytdlpArgs(['--dump-single-json','--skip-download'].concat(extra||[],[target])));
    let out='',err='';
    p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);
    p.on('error',()=>reject(httpError(500,'yt-dlp is not installed on this server.')));
    p.on('close',code=>{
      if(code!==0)return reject(httpError(502,'YouTube lookup failed: '+(err.split('\n').filter(Boolean).pop()||'unknown error')));
      try{resolve(JSON.parse(out));}catch(e){reject(httpError(502,'Unexpected response from yt-dlp.'));}
    });
  });
}

async function resolveLink(url){
  const k=kind(url);
  if(!k)throw httpError(400,'Paste a YouTube video link or a Spotify track link.');
  let meta=null,target=url;
  if(k==='spotify'){
    meta=await spotifyMeta(url);
    target='ytsearch5:'+(meta.artist?meta.artist+' ':'')+meta.title+' audio';
  }
  let info=await runJson(target,meta?['--flat-playlist']:[]),alternates=[];
  if(info&&info.entries){
    const ranked=meta?rankMatches(info.entries,meta):info.entries;
    info=ranked[0];alternates=ranked.slice(1,4).map(e=>e.id);
  }
  if(!info||!info.id)throw httpError(404,'No matching video was found.');
  if(info.duration&&info.duration>MAX_SECONDS)throw httpError(413,'That video is longer than '+Math.round(MAX_SECONDS/60)+' minutes.');
  if(!meta){
    // "Artist - Song (Official Video)" style titles
    let title=(info.track||info.title||'').replace(/\s*[\(\[][^\)\]]*(official|lyric|audio|video|live|visuali[sz]er|hd|4k)[^\)\]]*[\)\]]/ig,'').trim();
    let artist=info.artist||info.creator||'';
    const dash=/^(.+?)\s+[-–]\s+(.+)$/.exec(title);
    if(!info.track&&dash){artist=artist||dash[1];title=dash[2];}
    meta={title:title,artist:artist||(info.uploader||info.channel||'').replace(/\s*-\s*Topic$/,'')};
  }
  return {
    source:k,id:info.id,alternates,duration:info.duration||null,
    title:meta.title,artist:meta.artist,
    matched:info.title||'',url:'https://www.youtube.com/watch?v='+info.id
  };
}

let active=0,hasFfmpeg=null;
function ffmpegReady(){
  if(hasFfmpeg===null)hasFfmpeg=new Promise(r=>{const p=spawn(FFMPEG,['-version'],{stdio:'ignore'});p.on('error',()=>r(false));p.on('close',c=>r(c===0));});
  return hasFfmpeg;
}
// YouTube audio arrives as MP4 or WebM, which not every browser can decode, so it is converted
// to MP3 when ffmpeg is available. It is downloaded to a temporary file first because some MP4
// files keep their index at the end and cannot be converted while streaming.
async function streamAudio(id,res){
  if(!/^[A-Za-z0-9_-]{11}$/.test(id))throw httpError(400,'Invalid video id.');
  if(active>=MAX_DOWNLOADS)throw httpError(503,'The server is busy. Try again in a minute.');
  active++;
  const tmp=path.join(os.tmpdir(),'ccb-dl-'+id+'-'+Date.now()+'.audio');
  const procs=[];
  let closed=false;
  res.on('close',()=>{closed=true;procs.forEach(p=>{if(p.exitCode===null)p.kill('SIGKILL');});});
  function run(cmd,args){
    return new Promise((resolve,reject)=>{
      const p=spawn(cmd,args);procs.push(p);
      let err='';p.stderr.on('data',d=>err+=d);
      p.on('error',()=>reject(new Error(cmd+' is not installed on this server.')));
      p.on('close',code=>code===0?resolve():reject(new Error(err.split('\n').filter(Boolean).pop()||cmd+' exited '+code)));
    });
  }
  try{
    const convert=await ffmpegReady();
    await run(YTDLP,ytdlpArgs(['-f','bestaudio[ext=m4a]/bestaudio','--match-filter','duration<='+MAX_SECONDS,'--no-part','-o',tmp,'https://www.youtube.com/watch?v='+id]));
    if(closed)return;
    if(!convert){
      res.writeHead(200,{'Content-Type':'audio/mp4','Cache-Control':'no-store'});
      return await new Promise(r=>{const st=fs.createReadStream(tmp);st.pipe(res);st.on('close',r);});
    }
    const conv=spawn(FFMPEG,['-hide_banner','-loglevel','error','-i',tmp,'-vn','-ac','2','-ar','44100','-b:a','160k','-f','mp3','pipe:1']);
    procs.push(conv);
    let started=false,err='';
    conv.stderr.on('data',d=>err+=d);
    conv.stdout.once('data',chunk=>{
      started=true;
      res.writeHead(200,{'Content-Type':'audio/mpeg','Cache-Control':'no-store'});
      res.write(chunk);conv.stdout.pipe(res);
    });
    await new Promise(r=>conv.on('close',code=>{
      if(!started&&!closed)sendJson(res,502,{error:'Could not convert that audio: '+(err.split('\n').filter(Boolean).pop()||'exit '+code)});
      r();
    }));
  }catch(e){
    if(!res.headersSent&&!closed)sendJson(res,502,{error:'Could not download that audio: '+e.message});
  }finally{
    active=Math.max(0,active-1);
    fs.promises.unlink(tmp).catch(()=>{});
  }
}

// Lyrics transcription (fallback only) runs as a background job: one upload, then the page
// polls /api/job, so slow songs are not cut off by proxy timeouts.
function scriptCommand(name,file){
  const override=process.env[name.toUpperCase()+'_CMD'];
  if(override)return [override,[file]];
  return [PYTHON,[path.join(__dirname,name+'.py'),file]];
}
function runScript(name,file){
  const [cmd,args]=scriptCommand(name,file);
  return new Promise((resolve,reject)=>{
    const p=spawn(cmd,args);
    let out='',err='';
    p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);
    p.on('error',()=>reject(new Error(name+' is not installed on this server.')));
    p.on('close',code=>{
      if(code!==0){console.error(name,err.slice(-2000));return reject(new Error(name+' failed.'));}
      try{resolve(JSON.parse(out));}catch(e){reject(new Error('Unexpected response from '+name+'.'));}
    });
  });
}
function readBody(req,limit){
  return new Promise((resolve,reject)=>{
    const chunks=[];let size=0;
    req.on('data',c=>{size+=c.length;if(size>limit){reject(httpError(413,'That audio is too large.'));req.destroy();return;}chunks.push(c);});
    req.on('end',()=>resolve(Buffer.concat(chunks)));
    req.on('error',reject);
  });
}
const jobs=new Map();
let queue=Promise.resolve();
async function startJob(req,u){
  if(u.searchParams.get('lyrics')!=='1')throw httpError(400,'Nothing to do.');
  if([...jobs.values()].filter(j=>j.status!=='done'&&j.status!=='error').length>=5)throw httpError(503,'The server is busy. Try again in a few minutes.');
  const body=await readBody(req,MAX_UPLOAD);
  if(!body.length)throw httpError(400,'No audio was sent.');
  const id=Date.now().toString(36)+Math.random().toString(36).slice(2,8);
  const file=path.join(os.tmpdir(),'ccb-'+id+'.audio');
  await fs.promises.writeFile(file,body);
  const job={status:'queued',step:'',result:{},notes:[],created:Date.now()};
  jobs.set(id,job);
  queue=queue.then(async()=>{
    job.status='running';
    job.step='lyrics';
    try{Object.assign(job.result,await runScript('transcribe',file));}
    catch(e){job.notes.push(e.message);}
    job.status='done';job.step='';
  }).finally(()=>fs.promises.unlink(file).catch(()=>{}));
  return {id};
}
function jobStatus(id){
  const job=jobs.get(id);
  if(!job)throw httpError(404,'That job has expired. Analyze the song again.');
  const ahead=job.status==='queued'?[...jobs.values()].filter(j=>j.status!=='done'&&j.status!=='error'&&j.created<job.created).length:0;
  return {status:job.status,step:job.step,ahead,result:job.status==='done'?job.result:null,notes:job.notes};
}
setInterval(()=>{const now=Date.now();for(const [id,j] of jobs)if(now-j.created>30*60000)jobs.delete(id);},60000).unref();

let caps=null;
function which(cmd,args){
  return new Promise(r=>{const p=spawn(cmd,args,{stdio:'ignore'});p.on('error',()=>r(false));p.on('close',c=>r(c===0));});
}
async function capabilities(){
  if(!caps)caps=Promise.all([
    which(YTDLP,['--version']),
    process.env.TRANSCRIBE_CMD?Promise.resolve(true):which(PYTHON,['-c','import faster_whisper']),
    ffmpegReady()
  ]).then(([links,lyrics,mp3])=>({ok:true,links,lyrics,mp3}));
  return caps;
}

const hits=new Map();
function limited(ip){
  const now=Date.now(),list=(hits.get(ip)||[]).filter(t=>now-t<600000);
  list.push(now);hits.set(ip,list);
  return list.length>RATE_LIMIT;
}
function cors(req,res){
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  const origin=req.headers.origin;
  if(ORIGINS.includes('*'))res.setHeader('Access-Control-Allow-Origin','*');
  else if(origin&&ORIGINS.includes(origin)){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
}
function sendJson(res,status,obj){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(obj));}
function serveStatic(pathname,res){
  let rel=decodeURIComponent(pathname);
  if(rel.endsWith('/'))rel+='index.html';
  const file=path.normalize(path.join(STATIC_DIR,rel));
  if(!file.startsWith(STATIC_DIR+path.sep)||file.includes(path.sep+'server'+path.sep)){res.writeHead(404);return res.end();}
  fs.readFile(file,(err,data)=>{
    if(err){res.writeHead(404);return res.end('Not found');}
    res.writeHead(200,{'Content-Type':TYPES[path.extname(file)]||'application/octet-stream'});
    res.end(data);
  });
}

const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://localhost');
  cors(req,res);
  if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
  if(!u.pathname.startsWith('/api/'))return serveStatic(u.pathname,res);
  if(u.pathname==='/api/health')return sendJson(res,200,await capabilities());
  if(u.pathname==='/api/job'){try{return sendJson(res,200,jobStatus(u.searchParams.get('id')||''));}catch(e){return sendJson(res,e.status||500,{error:e.message});}}
  const ip=(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();
  if(limited(ip))return sendJson(res,429,{error:'Too many requests. Try again in a few minutes.'});
  try{
    if(u.pathname==='/api/resolve')return sendJson(res,200,await resolveLink((u.searchParams.get('url')||'').trim()));
    if(u.pathname==='/api/audio')return await streamAudio(u.searchParams.get('id')||'',res);
    if(u.pathname==='/api/analyze'&&req.method==='POST')return sendJson(res,200,await startJob(req,u));
    sendJson(res,404,{error:'Not found'});
  }catch(e){
    if(!res.headersSent)sendJson(res,e.status||500,{error:e.status?e.message:'Something went wrong on the server.'});
    if(!e.status)console.error(e);
  }
});

if(require.main===module)server.listen(PORT,()=>console.log('Chord Chart Builder running on http://localhost:'+PORT));
module.exports={kind,parseSpotifyPage,parseSpotifyEmbed,pickMatch,rankMatches,server};
