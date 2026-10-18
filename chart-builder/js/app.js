// =================== APP: UPLOAD, ANALYZE, EDIT, EXPORT ===================
(function(){
  var STORE='cb-chart-v1';
  var CHIPS=['Keys + pad','Acoustic only','Band in','Drums in','Drums out','No drums','Build','Full band','All in','Break down','Pull back','Hits','Hold','Half time','Vocals only','Fade out','Ring out'];
  var NAMES=['Intro','Verse 1','Verse 2','Verse 3','Verse 4','Pre-Chorus','Chorus','Chorus 2','Post-Chorus','Bridge','Bridge 2','Instrumental','Interlude','Turnaround','Tag','Vamp','Outro','Ending'];
  var STEP_W={fetch:14,decode:4,model:20,features:10,tempo:3,chords:3,structure:3,lyrics:40,chart:3};
  var file=null,source='file',chart=null,previewTimer=null,previewUrl=null,stepState={};

  function $(id){return document.getElementById(id);}
  function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  function save(){try{localStorage.setItem(STORE,JSON.stringify(chart));}catch(e){}}
  function load(){try{var s=localStorage.getItem(STORE);return s?JSON.parse(s):null;}catch(e){return null;}}
  // set while lyrics are being written; still set on the next visit means the page was killed
  var LYRICS_FLAG='cb-lyrics-running',CRASH_FLAG='cb-lyrics-crashed';
  function lyricsCrashed(){try{return !!localStorage.getItem(CRASH_FLAG);}catch(e){return false;}}

  // ---------- upload ----------
  function setFile(f){
    if(!f)return;
    file=f;
    $('cb-file-name').textContent=f.name;
    ready();
    var base=f.name.replace(/\.[^.]+$/,'').replace(/_/g,' ').trim(),parts=base.split(/\s+-\s+/);
    if(!$('cb-in-title').value){
      if(parts.length>1){$('cb-in-artist').value=$('cb-in-artist').value||parts[0];$('cb-in-title').value=parts.slice(1).join(' - ');}
      else $('cb-in-title').value=base;
    }
  }
  function report(step,frac,msg){
    var order=Object.keys(STEP_W),done=0,total=0;
    order.forEach(function(s){
      if(stepState[s]==='skip')return;
      total+=STEP_W[s];
      if(order.indexOf(s)<order.indexOf(step))done+=STEP_W[s];
    });
    done+=STEP_W[step]*Math.min(1,frac||0);
    $('cb-bar').style.width=Math.round(100*done/total)+'%';
    document.querySelectorAll('#cb-steps li').forEach(function(li){
      var s=li.dataset.step,i=order.indexOf(s),cur=order.indexOf(step);
      li.className=stepState[s]==='skip'?'skip':i<cur||(i===cur&&frac>=1)?'done':i===cur?'run':'';
    });
    if(msg!=null){$('cb-status').textContent=msg;$('cb-status').classList.remove('cb-error');}
  }
  function ready(){
    $('cb-analyze').disabled=source==='file'?!file:!CBS.kind($('cb-link').value);
  }
  async function getAudio(){
    if(source==='file'){
      stepState.fetch='skip';
      report('decode',0.1,'Reading '+file.name);
      return {buf:await file.arrayBuffer()};
    }
    var url=$('cb-link').value.trim();
    report('fetch',0.05,CBS.kind(url)==='spotify'?'Looking up the Spotify track':'Looking up the video');
    var info=await CBS.resolve(url);
    if(!$('cb-in-title').value&&info.title)$('cb-in-title').value=info.title;
    if(!$('cb-in-artist').value&&info.artist)$('cb-in-artist').value=info.artist;
    report('fetch',0.15,'Downloading audio'+(info.title?' for '+info.title:''));
    // YouTube sometimes refuses one upload of a song; try the other matches before giving up.
    var ids=[info.id].concat(info.alternates||[]),buf=null,lastErr=null;
    for(var i=0;i<ids.length&&!buf;i++){
      try{
        buf=await CBS.fetchAudio(ids[i],function(frac,bytes){
          report('fetch',0.15+0.85*frac,'Downloading audio '+(frac?Math.round(frac*100)+'%':(bytes/1048576).toFixed(1)+' MB'));
        });
      }catch(e){lastErr=e;console.warn('Download failed for',ids[i],e);if(i+1<ids.length)report('fetch',0.15,'Trying another copy of the song');}
    }
    if(!buf)throw new Error(/not a bot|Sign in/i.test(lastErr&&lastErr.message||'')?
      'YouTube blocked the download of this song. Try a different link for it, or upload the audio file.':(lastErr&&lastErr.message)||'Could not download that audio.');
    report('fetch',1);
    return {buf:buf,info:info};
  }
  async function analyzeFile(){
    var btn=$('cb-analyze');btn.disabled=true;$('cb-blank').disabled=true;
    $('cb-progress').style.display='block';
    var lyrics=$('cb-lyrics').value.trim(),auto=!lyrics&&$('cb-autolyrics').checked;
    stepState={lyrics:auto?'':'skip',fetch:source==='file'?'skip':'',model:''};
    var t0=Date.now();
    try{
      var got=await getAudio();
      report('decode',0.3,'Decoding audio');
      var buf=await CBA.decode(got.buf);got=null;
      // Make the speech model's 16 kHz copy now, then swap the decoded audio for one mono copy:
      // keeping several full copies of a song runs phones out of memory.
      var pcm16=auto&&!lyrics?await CBA.resample(buf,16000):null;
      buf=await CBA.toMono44(buf);
      var title=$('cb-in-title').value.trim(),artist=$('cb-in-artist').value.trim(),words=null,note='';
      // Lyrics: pasted, otherwise transcribed from the vocals in the audio itself.
      var needLyrics=auto&&!words&&!lyrics;
      // Chords: the trained chord model runs on this device (no server involved).
      var chordSegs=null;
      report('model',0.02,'Recognizing chords on this device');
      try{chordSegs=await CBC.analyze(buf,function(f){report('model',f,'Recognizing chords on this device');});}
      catch(e){console.warn('On-device chord model failed',e);}
      report('model',1);
      var A=await CBA.analyze(buf,{time:$('cb-in-time').value,chords:chordSegs},report);
      var chordNote=chordSegs?'Chords: recognized on this device':'Chords: basic detector (chord model did not load)';
      // A phone that runs out of memory during lyrics reloads the page, so save the chords chart
      // first and leave a flag; after a reload the chart reopens and lyrics are skipped next time.
      if(needLyrics&&lyricsCrashed()){
        needLyrics=false;
        note='Lyrics: skipped, because this device ran out of memory writing them last time. Paste the lyrics, or make the chart on a computer.';
      }
      if(needLyrics){
        chart=CBB.build(A,{lyrics:lyrics,title:title,artist:artist});
        chart.made=chordNote+'  ·  Lyrics: this device ran out of memory writing them, so this chart has chords only. Paste the lyrics, or make the chart on a computer.';
        save();
        try{localStorage.setItem(LYRICS_FLAG,String(Date.now()));}catch(e){}
      }
      // Lyrics: the speech model also runs on this device. The server is only a fallback for
      // browsers that cannot run it.
      if(needLyrics){
        var tick=setInterval(function(){
          var s=$('cb-status');
          if(/^Listening for lyrics/.test(s.textContent))s.textContent='Listening for lyrics on this device. Longer songs can take a few minutes. ('+Math.round((Date.now()-t0)/1000)+'s)';
        },1000);
        try{
          report('lyrics',0.05,'Loading the speech model');
          words=await CBB.transcribe(pcm16||await CBA.resample(buf,16000),report);pcm16=null;
        }catch(e){
          console.warn('On-device lyric transcription failed',e);
          try{
            if((await CBS.health()).lyrics){
              report('lyrics',0.3,'This browser could not run the speech model, so the server is writing out the lyrics');
              var r=await CBS.analyzeAudio(await CBA.resample(buf,22050),22050,{lyrics:true,maxMs:8*60000},function(){});
              words=r.words||[];
            }
          }catch(e2){console.warn('Server lyric transcription failed',e2);}
        }finally{clearInterval(tick);}
        try{localStorage.removeItem(LYRICS_FLAG);}catch(e){}
        note=words&&words.length?'Lyrics transcribed from the vocals ('+words.length+' words). Check them before rehearsal.':
          words?'No clear vocals heard. Paste the lyrics to add them.':'Lyrics could not be transcribed here, so the chart has chords only. Paste the lyrics to add them.';
      }
      if(!chordSegs)note=(note?note+' ':'')+'Chords came from the basic detector because the chord model could not load, so check them closely.';
      if(stepState.lyrics!=='skip')report('lyrics',1,note||'No lyrics found. Paste them to add them.');
      report('chart',0.5,'Building the chart');
      chart=CBB.build(A,{lyrics:lyrics,words:words,title:title,artist:artist});
      // shown above the editor so it is clear where the chords and lyrics came from
      chart.made=[chordNote,lyrics&&!note?'Lyrics: pasted':(note||'Lyrics: none')].join('  ·  ');
      report('chart',1,'Done');
      openEditor();
    }catch(e){
      console.error(e);
      $('cb-status').textContent=(e&&e.message)||String(e);
      if(source==='file'&&/decod|EncodingError|Unable/i.test($('cb-status').textContent))$('cb-status').textContent='That file could not be read. Try an MP3, M4A, or WAV file.';
      $('cb-status').classList.add('cb-error');
    }finally{$('cb-blank').disabled=false;ready();}
  }
  function blankChart(){
    chart={title:$('cb-in-title').value.trim()||'New Song',artist:$('cb-in-artist').value.trim(),key:'G',tempo:72,time:'4/4',roadmap:'',notes:'',
      notation:'numbers',columns:2,size:'M',condense:false,sections:[
        {name:'Intro',repeat:1,mark:'p',cue:'Keys + pad',text:'| G | C | Em | D |'},
        {name:'Verse 1',repeat:1,mark:'mp',cue:'',text:'[G]Type your [C]lyrics here\n[Em]Chords go in [D]brackets'},
        {name:'Chorus',repeat:2,mark:'f',cue:'Full band',text:'[C]Chorus [G]line\n[D]Chorus [Em]line'}
      ]};
    chart.roadmap=CBB.roadmap(chart.sections);
    openEditor();
  }

  // ---------- editor ----------
  function openEditor(){
    $('cb-upload').style.display='none';
    $('cb-editor').style.display='block';
    renderEditor();
    save();
    preview(true);
    window.scrollTo(0,0);
  }
  function seg(id,val){document.querySelectorAll('#'+id+' button').forEach(function(b){b.classList.toggle('on',b.dataset.v===String(val));});}
  function renderEditor(){
    $('cb-title').value=chart.title||'';$('cb-artist').value=chart.artist||'';
    var ks=$('cb-key');
    if(!ks.options.length)CBT.KEYS.forEach(function(k){var o=document.createElement('option');o.value=o.textContent=k;ks.appendChild(o);});
    if(CBT.KEYS.indexOf(chart.key)<0){var o=document.createElement('option');o.value=o.textContent=chart.key;ks.appendChild(o);}
    ks.value=chart.key;
    $('cb-tempo').value=chart.tempo||'';$('cb-time').value=chart.time||'4/4';
    $('cb-roadmap').value=chart.roadmap||'';$('cb-notes').value=chart.notes||'';
    $('cb-tr-key').textContent=chart.key;
    $('cb-condense').checked=!!chart.condense;
    $('cb-made').textContent=chart.made||'';$('cb-made').style.display=chart.made?'':'none';
    seg('cb-notation',chart.notation);seg('cb-columns',chart.columns);seg('cb-size',chart.size);
    renderSections();
  }
  function renderSections(){
    var html='<datalist id="cb-names">'+NAMES.map(function(n){return '<option value="'+n+'">';}).join('')+'</datalist>';
    chart.sections.forEach(function(s,i){
      var cues=(s.cue||'').split(/\s*·\s*/);
      html+='<div class="cb-sec" data-i="'+i+'">'+
        '<div class="cb-sec-head">'+
          '<input class="cb-input" data-f="name" list="cb-names" value="'+esc(s.name)+'" aria-label="Section name">'+
          '<select class="cb-select" data-f="repeat" aria-label="Repeat">'+[1,2,3,4].map(function(r){return '<option value="'+r+'"'+(+s.repeat===r?' selected':'')+'>'+(r===1?'x1':'x'+r)+'</option>';}).join('')+'</select>'+
          '<select class="cb-select" data-f="mark" aria-label="Dynamic marking">'+['','pp','p','mp','mf','f','ff'].map(function(m){return '<option value="'+m+'"'+(s.mark===m?' selected':'')+'>'+(m||'dyn')+'</option>';}).join('')+'</select>'+
          '<button class="cb-icon-btn" data-a="up" title="Move up">&uarr;</button>'+
          '<button class="cb-icon-btn" data-a="down" title="Move down">&darr;</button>'+
          '<button class="cb-icon-btn" data-a="dup" title="Duplicate">+</button>'+
          '<button class="cb-icon-btn" data-a="del" title="Delete">&times;</button>'+
        '</div>'+
        (s.info?'<div class="cb-sec-meta">'+esc(s.info)+'</div>':'')+
        '<input class="cb-input" data-f="cue" value="'+esc(s.cue)+'" placeholder="Band dynamics, e.g. Drums in · Build">'+
        '<div class="cb-chips">'+CHIPS.map(function(c){return '<button class="cb-chip'+(cues.indexOf(c)>-1?' on':'')+'" data-chip="'+esc(c)+'">'+esc(c)+'</button>';}).join('')+'</div>'+
        '<textarea class="cb-textarea cb-mono" data-f="text" spellcheck="false" rows="'+Math.min(14,Math.max(4,(s.text||'').split('\n').length+1))+'">'+esc(s.text)+'</textarea>'+
      '</div>';
    });
    $('cb-sections').innerHTML=html;
  }
  function changed(){save();preview();}
  var renderSeq=0;
  async function showPdf(doc){
    var box=$('cb-preview'),seq=++renderSeq;
    if(!window.pdfjsLib){
      var url=URL.createObjectURL(doc.output('blob')),fr=box.querySelector('iframe');
      if(!fr){fr=document.createElement('iframe');fr.title='Chart preview';box.replaceChildren(fr);}
      fr.src=url+'#toolbar=0&navpanes=0&view=FitH';
      if(previewUrl)setTimeout(function(u){URL.revokeObjectURL(u);}.bind(null,previewUrl),4000);
      previewUrl=url;return;
    }
    var pdf=await pdfjsLib.getDocument({data:new Uint8Array(doc.output('arraybuffer'))}).promise,pages=[];
    var w=Math.max(300,box.clientWidth-24),dpr=Math.min(2,window.devicePixelRatio||1);
    for(var i=1;i<=pdf.numPages;i++){
      var page=await pdf.getPage(i),vp=page.getViewport({scale:w/page.getViewport({scale:1}).width*dpr});
      var c=document.createElement('canvas');c.width=Math.round(vp.width);c.height=Math.round(vp.height);
      await page.render({canvasContext:c.getContext('2d'),viewport:vp}).promise;
      if(seq!==renderSeq){pdf.destroy();return;}
      pages.push(c);
    }
    pdf.destroy();
    box.replaceChildren.apply(box,pages);
  }
  function preview(now){
    clearTimeout(previewTimer);
    previewTimer=setTimeout(async function(){
      try{showPdf(CBP.render(chart,await CBP.loadFonts())).catch(function(e){console.error(e);});}
      catch(e){console.error(e);}
    },now?50:500);
  }
  // Inside a Claude artifact, files are offered through the viewer's save dialog.
  async function savePdf(doc,name){
    var dl=window.claude&&window.claude.use?await window.claude.use('downloads'):null;
    if(!dl)return doc.save(name);
    try{await dl.save({filename:name,data:doc.output('blob')});}
    catch(e){if(e&&e.code!=='declined')$('cb-download').textContent='Download unavailable here';}
  }
  function slug(s){return (s||'chart').replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'')||'chart';}
  function transpose(semis){
    var nk=CBT.transposeKey(chart.key,semis);
    chart.sections.forEach(function(s){s.text=CBT.transposeText(s.text||'',semis,nk);});
    chart.key=nk;
    renderEditor();changed();
  }

  // ---------- events ----------
  document.addEventListener('DOMContentLoaded',function(){
    CBP.loadFonts();
    $('cb-source').addEventListener('click',function(e){
      var b=e.target.closest('button');if(!b)return;
      source=b.dataset.v;seg('cb-source',source);
      $('cb-src-file').style.display=source==='file'?'':'none';
      $('cb-src-link').style.display=source==='link'?'':'none';
      ready();
    });
    $('cb-link').addEventListener('input',function(){
      var k=CBS.kind(this.value);
      $('cb-link-note').textContent=!this.value.trim()?'Paste a YouTube video or a Spotify track. Spotify links are matched to the same song on YouTube, since Spotify does not share its audio.':
        k==='youtube'?'YouTube link ready.':k==='spotify'?'Spotify track ready. The builder will find the same song on YouTube to listen to.':'That does not look like a YouTube video or Spotify track link.';
      ready();
    });
    var drop=$('cb-drop');
    $('cb-file').addEventListener('change',function(e){setFile(e.target.files[0]);});
    ['dragenter','dragover'].forEach(function(ev){drop.addEventListener(ev,function(e){e.preventDefault();drop.classList.add('drag');});});
    ['dragleave','drop'].forEach(function(ev){drop.addEventListener(ev,function(e){e.preventDefault();drop.classList.remove('drag');});});
    drop.addEventListener('drop',function(e){if(e.dataTransfer.files[0])setFile(e.dataTransfer.files[0]);});
    $('cb-analyze').addEventListener('click',analyzeFile);
    $('cb-blank').addEventListener('click',blankChart);
    if(load())$('cb-resume').style.display='';
    var interrupted=null;try{interrupted=localStorage.getItem(LYRICS_FLAG);}catch(e){}
    function crashNote(){
      if(!lyricsCrashed())return;
      $('cb-autolyrics').checked=false;
      $('cb-autolyrics').nextElementSibling.textContent='Write the lyrics from the vocals. This device ran out of memory doing that last time, so it is off. Tick to try again anyway.';
    }
    $('cb-autolyrics').addEventListener('change',function(){if(this.checked)try{localStorage.removeItem(CRASH_FLAG);}catch(e){}});
    if(interrupted){
      try{localStorage.removeItem(LYRICS_FLAG);localStorage.setItem(CRASH_FLAG,'1');}catch(e){}
      chart=load();
      if(chart)openEditor();
    }
    crashNote();
    $('cb-resume').addEventListener('click',function(){chart=load();if(chart)openEditor();});
    $('cb-new').addEventListener('click',function(){
      $('cb-editor').style.display='none';$('cb-upload').style.display='block';
      $('cb-progress').style.display='none';$('cb-resume').style.display=load()?'':'none';
    });
    $('cb-download').addEventListener('click',async function(){
      try{await savePdf(CBP.render(chart,await CBP.loadFonts()),slug(chart.title)+'-'+slug(chart.key)+'.pdf');}
      catch(e){$('cb-download').textContent='Download failed';console.error(e);}
    });
    var meta={'cb-title':'title','cb-artist':'artist','cb-tempo':'tempo','cb-time':'time','cb-roadmap':'roadmap','cb-notes':'notes','cb-key':'key'};
    Object.keys(meta).forEach(function(id){
      $(id).addEventListener('input',function(e){
        chart[meta[id]]=e.target.value;
        if(id==='cb-key')$('cb-tr-key').textContent=e.target.value;
        changed();
      });
    });
    $('cb-roadmap-auto').addEventListener('click',function(){chart.roadmap=CBB.roadmap(chart.sections);$('cb-roadmap').value=chart.roadmap;changed();});
    [['cb-notation','notation'],['cb-columns','columns'],['cb-size','size']].forEach(function(p){
      $(p[0]).addEventListener('click',function(e){
        var b=e.target.closest('button');if(!b)return;
        chart[p[1]]=p[1]==='columns'?+b.dataset.v:b.dataset.v;seg(p[0],b.dataset.v);changed();
      });
    });
    $('cb-condense').addEventListener('change',function(e){chart.condense=e.target.checked;changed();});
    $('cb-tr-up').addEventListener('click',function(){transpose(1);});
    $('cb-tr-down').addEventListener('click',function(){transpose(-1);});
    $('cb-add-sec').addEventListener('click',function(){
      chart.sections.push({name:'Chorus',repeat:1,mark:'',cue:'',text:''});renderSections();changed();
    });
    var box=$('cb-sections');
    box.addEventListener('input',function(e){
      var card=e.target.closest('.cb-sec'),f=e.target.dataset.f;if(!card||!f)return;
      var s=chart.sections[+card.dataset.i];
      s[f]=f==='repeat'?+e.target.value:e.target.value;
      if(f==='cue')card.querySelectorAll('.cb-chip').forEach(function(c){c.classList.toggle('on',e.target.value.split(/\s*·\s*/).indexOf(c.dataset.chip)>-1);});
      changed();
    });
    box.addEventListener('click',function(e){
      var card=e.target.closest('.cb-sec');if(!card)return;
      var i=+card.dataset.i,s=chart.sections[i],chip=e.target.closest('.cb-chip'),act=e.target.closest('[data-a]');
      if(chip){
        var list=(s.cue||'').split(/\s*·\s*/).filter(Boolean),c=chip.dataset.chip,at=list.indexOf(c);
        if(at>-1)list.splice(at,1);else list.push(c);
        s.cue=list.join(' · ');
        card.querySelector('[data-f="cue"]').value=s.cue;chip.classList.toggle('on',at<0);
        changed();return;
      }
      if(!act)return;
      var a=act.dataset.a,L=chart.sections;
      if(a==='up'&&i>0){L.splice(i-1,0,L.splice(i,1)[0]);}
      else if(a==='down'&&i<L.length-1){L.splice(i+1,0,L.splice(i,1)[0]);}
      else if(a==='dup'){L.splice(i+1,0,JSON.parse(JSON.stringify(s)));}
      else if(a==='del'){
        // second click confirms
        if(!act.classList.contains('arm')){act.classList.add('arm');act.textContent='Delete?';act.style.width='auto';setTimeout(function(){act.classList.remove('arm');act.innerHTML='&times;';act.style.width='';},3000);return;}
        L.splice(i,1);
      }
      else return;
      renderSections();changed();
    });
  });
})();
