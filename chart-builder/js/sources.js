// =================== SOURCES: YOUTUBE / SPOTIFY LINKS AND LYRICS LOOKUP ===================
// Browsers cannot pull audio out of YouTube or Spotify directly, so links go through the small
// audio service in server/ (yt-dlp). Spotify links are matched to the same song on YouTube.
var CBS=(function(){
  var STORE='cb-audio-service';

  function service(){
    var v='';
    try{v=localStorage.getItem(STORE)||'';}catch(e){}
    if(!v&&window.CB_CONFIG)v=window.CB_CONFIG.audioService||'';
    return v.replace(/\/+$/,'');
  }
  function setService(v){try{localStorage.setItem(STORE,(v||'').trim());}catch(e){}}

  function kind(url){
    url=(url||'').trim();
    if(/^(https?:\/\/)?((www|m|music)\.)?(youtube\.com|youtu\.be)\//i.test(url))return 'youtube';
    if(/^(https?:\/\/)?open\.spotify\.com\/(intl-[a-z-]+\/)?track\//i.test(url)||/^spotify:track:/i.test(url))return 'spotify';
    return null;
  }

  async function api(path){
    var base=service();
    if(!base&&location.protocol==='file:')throw new Error('Link import needs the audio service. Add its address under Settings.');
    var res;
    try{res=await fetch(base+path);}
    catch(e){throw new Error('Could not reach the audio service'+(base?' at '+base:'')+'. Check the address under Settings.');}
    if(!res.ok){
      var msg='';try{msg=(await res.json()).error;}catch(e){}
      if(res.status===404&&!msg)msg='No audio service found at this address. Add its address under Settings.';
      throw new Error(msg||('Audio service error '+res.status));
    }
    return res;
  }
  async function resolve(url){return (await api('/api/resolve?url='+encodeURIComponent(url.trim()))).json();}

  async function fetchAudio(id,onProgress){
    var res=await api('/api/audio?id='+encodeURIComponent(id));
    var total=+res.headers.get('Content-Length')||0;
    if(!res.body||!res.body.getReader)return res.arrayBuffer();
    var reader=res.body.getReader(),chunks=[],got=0;
    for(;;){
      var r=await reader.read();
      if(r.done)break;
      chunks.push(r.value);got+=r.value.length;
      onProgress(total?got/total:0,got);
    }
    var out=new Uint8Array(got),o=0;
    chunks.forEach(function(c){out.set(c,o);o+=c.length;});
    return out.buffer;
  }

  // ---------- lyrics from LRCLIB (free, open lyrics database with line timings) ----------
  function cleanTitle(t){
    return (t||'').replace(/\s*[\(\[][^\)\]]*(official|lyric|audio|video|live|visualizer|hd)[^\)\]]*[\)\]]/ig,'')
      .replace(/\s*\|.*$/,'').replace(/\s+-\s+(official|lyric).*$/i,'').trim();
  }
  async function lyrics(title,artist,duration){
    title=cleanTitle(title);
    if(!title)return null;
    var base='https://lrclib.net/api/';
    var hit=null;
    try{
      if(artist){
        var q='get?track_name='+encodeURIComponent(title)+'&artist_name='+encodeURIComponent(artist)+(duration?'&duration='+Math.round(duration):'');
        var r=await fetch(base+q);
        if(r.ok)hit=await r.json();
      }
      if(!hit||(!hit.syncedLyrics&&!hit.plainLyrics)){
        var r2=await fetch(base+'search?q='+encodeURIComponent((artist?artist+' ':'')+title));
        if(r2.ok){
          var list=await r2.json();
          list=list.filter(function(x){return x.syncedLyrics||x.plainLyrics;});
          if(duration)list.sort(function(a,b){return Math.abs(a.duration-duration)-Math.abs(b.duration-duration);});
          list.sort(function(a,b){return (!!b.syncedLyrics)-(!!a.syncedLyrics);});
          hit=list.filter(function(x){return !duration||Math.abs(x.duration-duration)<8;})[0]||null;
        }
      }
    }catch(e){console.warn('Lyrics lookup failed',e);return null;}
    if(!hit)return null;
    return {plain:hit.plainLyrics||'',words:hit.syncedLyrics?syncedWords(hit.syncedLyrics):null,source:'LRCLIB'};
  }
  // "[01:02.35] line" -> words with estimated timing, one line break flag per lyric line
  function syncedWords(lrc){
    var lines=[];
    lrc.split('\n').forEach(function(l){
      var m=/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/.exec(l.trim());
      if(m)lines.push({t:+m[1]*60+ +m[2],text:m[3].trim()});
    });
    var words=[];
    lines.forEach(function(ln,i){
      if(!ln.text)return;
      var parts=ln.text.split(/\s+/),next=lines[i+1]?lines[i+1].t:ln.t+4;
      var span=Math.min(next-ln.t,0.42*parts.length+1.2)*0.92,step=span/parts.length;
      parts.forEach(function(w,j){words.push({text:w,start:ln.t+j*step,end:ln.t+(j+1)*step,br:j===0});});
    });
    return words;
  }

  return {service:service,setService:setService,kind:kind,resolve:resolve,fetchAudio:fetchAudio,lyrics:lyrics,syncedWords:syncedWords};
})();
