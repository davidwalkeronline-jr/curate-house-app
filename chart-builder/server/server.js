// Chord Chart Builder server.
// Serves the builder page, turns YouTube or Spotify links into audio the browser can analyze
// (yt-dlp; Spotify tracks are matched to the same song on YouTube), and transcribes sung
// lyrics with word timings (faster-whisper via transcribe.py).
'use strict';
const http=require('http');
const {spawn}=require('child_process');
const fs=require('fs');
const os=require('os');
const path=require('path');

const PORT=+process.env.PORT||8787;
const YTDLP=process.env.YTDLP_PATH||'yt-dlp';
const COOKIES=process.env.YTDLP_COOKIES||'';
const MAX_SECONDS=+process.env.MAX_DURATION||900;
const ORIGINS=(process.env.ALLOWED_ORIGINS||'*').split(',').map(s=>s.trim()).filter(Boolean);
const STATIC_DIR=path.join(__dirname,'..');
const MAX_DOWNLOADS=+process.env.MAX_DOWNLOADS||3;
const RATE_LIMIT=+process.env.RATE_LIMIT||30; // API requests per IP per 10 minutes
const PYTHON=process.env.PYTHON_PATH||'python3';
const TRANSCRIBE_CMD=process.env.TRANSCRIBE_CMD||''; // override for testing: a command taking the audio path
const MAX_TRANSCRIBES=+process.env.MAX_TRANSCRIBES||1;
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
async function spotifyMeta(url){
  const page=spotifyUrl(url);
  if(!page)throw httpError(400,'That Spotify link does not point to a track.');
  const res=await fetch(page,{headers:{'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36','Accept-Language':'en'}});
  if(!res.ok)throw httpError(502,'Spotify did not return that track.');
  const meta=parseSpotifyPage(await res.text());
  if(!meta||!meta.title)throw httpError(502,'Could not read the song title from Spotify.');
  return meta;
}

function httpError(status,message){const e=new Error(message);e.status=status;return e;}
function ytdlpArgs(extra){return (COOKIES?['--cookies',COOKIES]:[]).concat(['--no-playlist','--no-warnings'],extra);}
function runJson(target){
  return new Promise((resolve,reject)=>{
    const p=spawn(YTDLP,ytdlpArgs(['--dump-single-json','--skip-download',target]));
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
    target='ytsearch1:'+meta.artist+' '+meta.title+' audio';
  }
  let info=await runJson(target);
  if(info&&info.entries)info=info.entries[0];
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
    source:k,id:info.id,duration:info.duration||null,
    title:meta.title,artist:meta.artist,
    matched:info.title||'',url:'https://www.youtube.com/watch?v='+info.id
  };
}

let active=0;
function streamAudio(id,res){
  if(!/^[A-Za-z0-9_-]{11}$/.test(id))throw httpError(400,'Invalid video id.');
  if(active>=MAX_DOWNLOADS)throw httpError(503,'The server is busy. Try again in a minute.');
  active++;
  const p=spawn(YTDLP,ytdlpArgs(['-f','bestaudio[ext=m4a]/bestaudio','--match-filter','duration<='+MAX_SECONDS,'-o','-','https://www.youtube.com/watch?v='+id]));
  let started=false,err='';
  const done=()=>{active=Math.max(0,active-1);};
  p.stderr.on('data',d=>err+=d);
  // headers wait for the first audio bytes so a failed download can still answer with an error
  p.stdout.once('data',chunk=>{
    started=true;
    res.writeHead(200,{'Content-Type':'audio/mp4','Cache-Control':'no-store'});
    res.write(chunk);
    p.stdout.pipe(res);
  });
  p.on('close',code=>{
    done();
    if(!started)sendJson(res,502,{error:'Could not download that audio: '+(err.split('\n').filter(Boolean).pop()||'exit '+code)});
  });
  p.on('error',()=>{done();if(!started)sendJson(res,500,{error:'yt-dlp is not installed on this server.'});});
  res.on('close',()=>{if(p.exitCode===null)p.kill('SIGKILL');});
}

// ---------- lyrics ----------
function transcribeCommand(file){
  if(TRANSCRIBE_CMD)return [TRANSCRIBE_CMD,[file]];
  return [PYTHON,[path.join(__dirname,'transcribe.py'),file]];
}
let transcribing=0;
function readBody(req,limit){
  return new Promise((resolve,reject)=>{
    const chunks=[];let size=0;
    req.on('data',c=>{size+=c.length;if(size>limit){reject(httpError(413,'That audio is too large to transcribe.'));req.destroy();return;}chunks.push(c);});
    req.on('end',()=>resolve(Buffer.concat(chunks)));
    req.on('error',reject);
  });
}
async function transcribe(req){
  if(transcribing>=MAX_TRANSCRIBES)throw httpError(503,'The lyrics transcriber is busy. Try again in a minute.');
  transcribing++;
  const file=path.join(os.tmpdir(),'ccb-'+process.pid+'-'+Date.now()+'-'+Math.random().toString(36).slice(2)+'.audio');
  try{
    const body=await readBody(req,MAX_UPLOAD);
    if(!body.length)throw httpError(400,'No audio was sent.');
    await fs.promises.writeFile(file,body);
    const [cmd,args]=transcribeCommand(file);
    return await new Promise((resolve,reject)=>{
      const p=spawn(cmd,args);
      let out='',err='';
      p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);
      p.on('error',()=>reject(httpError(501,'Lyrics transcription is not installed on this server.')));
      p.on('close',code=>{
        if(code!==0){console.error(err);return reject(httpError(502,'Lyrics transcription failed.'));}
        try{resolve(JSON.parse(out));}catch(e){reject(httpError(502,'Unexpected response from the transcriber.'));}
      });
    });
  }finally{
    transcribing--;
    fs.promises.unlink(file).catch(()=>{});
  }
}
let caps=null;
function which(cmd,args){
  return new Promise(r=>{const p=spawn(cmd,args,{stdio:'ignore'});p.on('error',()=>r(false));p.on('close',c=>r(c===0));});
}
async function capabilities(){
  if(!caps)caps=Promise.all([
    which(YTDLP,['--version']),
    TRANSCRIBE_CMD?Promise.resolve(true):which(PYTHON,['-c','import faster_whisper'])
  ]).then(([links,lyrics])=>({ok:true,links,lyrics}));
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
  const ip=(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();
  if(limited(ip))return sendJson(res,429,{error:'Too many requests. Try again in a few minutes.'});
  try{
    if(u.pathname==='/api/resolve')return sendJson(res,200,await resolveLink((u.searchParams.get('url')||'').trim()));
    if(u.pathname==='/api/audio')return streamAudio(u.searchParams.get('id')||'',res);
    if(u.pathname==='/api/transcribe'&&req.method==='POST')return sendJson(res,200,await transcribe(req));
    sendJson(res,404,{error:'Not found'});
  }catch(e){
    if(!res.headersSent)sendJson(res,e.status||500,{error:e.status?e.message:'Something went wrong on the server.'});
    if(!e.status)console.error(e);
  }
});

if(require.main===module)server.listen(PORT,()=>console.log('Chord Chart Builder running on http://localhost:'+PORT));
module.exports={kind,parseSpotifyPage,server};
