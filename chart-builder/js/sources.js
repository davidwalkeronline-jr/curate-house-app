// =================== SOURCES: LINKS AND FALLBACK LYRICS TRANSCRIPTION ===================
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
  // Fallback lyrics transcription: one upload, then poll the job until the server is done.
  async function analyzeAudio(pcm,rate,want,onStatus){
    var q='?lyrics='+(want.lyrics?1:0);
    var job=await (await api('/api/analyze'+q,{method:'POST',headers:{'Content-Type':'audio/wav'},body:wav16(pcm,rate)})).json();
    var deadline=Date.now()+(want.maxMs||8*60000);
    for(;;){
      if(Date.now()>deadline)throw new Error('The server took too long to write out the lyrics.');
      await new Promise(function(r){setTimeout(r,2500);});
      var st=await (await api('/api/job?id='+encodeURIComponent(job.id))).json();
      if(st.notes&&st.notes.length)console.warn('Server notes',st.notes);
      if(st.status==='done')return Object.assign({notes:st.notes||[]},st.result||{});
      onStatus(st);
    }
  }

  return {service:service,health:health,kind:kind,resolve:resolve,fetchAudio:fetchAudio,analyzeAudio:analyzeAudio};
})();
