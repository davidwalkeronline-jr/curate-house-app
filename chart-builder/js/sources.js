// =================== SOURCES: LINKS, LYRICS LOOKUP, LYRICS TRANSCRIPTION ===================
// Browsers cannot pull audio out of YouTube or Spotify, so links go through the builder's server
// (server/, yt-dlp). Spotify links are matched to the same song on YouTube. The server also
// transcribes sung lyrics with word timings.
var CBS=(function(){
  function service(){return ((window.CB_CONFIG&&window.CB_CONFIG.audioService)||'').replace(/\/+$/,'');}

  // What the server can do: {links, lyrics}. Both false when the page runs without it.
  var healthP=null;
  function health(){
    if(!healthP)healthP=(location.protocol==='file:'&&!service()?Promise.resolve(null):
      fetch(service()+'/api/health').then(function(r){return r.ok?r.json():null;}).catch(function(){return null;}))
      .then(function(h){return {links:!!(h&&h.links),lyrics:!!(h&&h.lyrics)};});
    return healthP;
  }

  function kind(url){
    url=(url||'').trim();
    if(/^(https?:\/\/)?((www|m|music)\.)?(youtube\.com|youtu\.be)\//i.test(url))return 'youtube';
    if(/^(https?:\/\/)?open\.spotify\.com\/(intl-[a-z-]+\/)?track\//i.test(url)||/^spotify:track:/i.test(url))return 'spotify';
    return null;
  }

  async function api(path,init){
    var base=service();
    if(!base&&location.protocol==='file:')throw new Error('Song links work when the builder runs on its own website. Upload the audio file instead.');
    var res;
    try{res=await fetch(base+path,init);}
    catch(e){throw new Error('Could not reach the builder\'s server. Check your connection and try again.');}
    if(!res.ok){
      var msg='';try{msg=(await res.json()).error;}catch(e){}
      if(res.status===404&&!msg)msg='Song links work when the builder runs on its own website. Upload the audio file instead.';
      throw new Error(msg||('Server error '+res.status));
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

  // ---------- lyrics transcription on the server ----------
  function wav16(pcm,rate){
    var n=pcm.length,buf=new ArrayBuffer(44+n*2),v=new DataView(buf);
    function str(o,t){for(var i=0;i<t.length;i++)v.setUint8(o+i,t.charCodeAt(i));}
    str(0,'RIFF');v.setUint32(4,36+n*2,true);str(8,'WAVE');str(12,'fmt ');
    v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,rate,true);
    v.setUint32(28,rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,n*2,true);
    for(var i=0;i<n;i++){var x=Math.max(-1,Math.min(1,pcm[i]));v.setInt16(44+i*2,x<0?x*0x8000:x*0x7FFF,true);}
    return new Blob([buf],{type:'audio/wav'});
  }
  async function transcribe(pcm16){
    var res=await api('/api/transcribe',{method:'POST',headers:{'Content-Type':'audio/wav'},body:wav16(pcm16,16000)});
    return ((await res.json()).words||[]).filter(function(w){return w&&w.text;});
  }

  return {service:service,health:health,kind:kind,resolve:resolve,fetchAudio:fetchAudio,lyrics:lyrics,syncedWords:syncedWords,transcribe:transcribe};
})();
