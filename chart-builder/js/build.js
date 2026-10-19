// =================== CHORD CHART BUILDER: ANALYSIS -> CHART ===================
var CBB=(function(){
  var HDR=/^[\[(]?\s*(verse|chorus|pre[- ]?chorus|post[- ]?chorus|bridge|tag|intro|outro|ending|interlude|refrain|vamp|instrumental|turnaround|hook)\s*(\d*)\s*[\])]?\s*:?\s*(?:[x×]\s*(\d+))?\s*$/i;
  var TYPE={verse:'Verse',chorus:'Chorus',refrain:'Refrain',hook:'Chorus',prechorus:'Pre-Chorus',postchorus:'Post-Chorus',bridge:'Bridge',tag:'Tag',
    intro:'Intro',outro:'Outro',ending:'Ending',interlude:'Interlude',vamp:'Vamp',instrumental:'Instrumental',turnaround:'Turnaround'};
  var ABBR={'Intro':'I','Verse':'V','Pre-Chorus':'PC','Chorus':'C','Post-Chorus':'Po','Bridge':'B','Instrumental':'In','Interlude':'It',
    'Turnaround':'Ta','Tag':'T','Vamp':'Vp','Refrain':'Rf','Outro':'O','Ending':'E'};

  function norm(s){return s.toLowerCase().replace(/[^a-z0-9' ]+/g,' ').replace(/\s+/g,' ').trim();}
  function baseType(name){
    var m=/^([A-Za-z-]+(?:\s[A-Za-z]+)?)/.exec(name||'');
    if(!m)return name;
    var k=m[1].toLowerCase().replace(/[- ]/g,'');
    return TYPE[k]||m[1];
  }

  // ---------- pasted lyrics ----------
  function parseLyrics(text){
    var lines=(text||'').replace(/\r/g,'').split('\n'),blocks=[],cur=null;
    function flush(){if(cur&&cur.lines.length)blocks.push(cur);cur=null;}
    lines.forEach(function(raw){
      var line=raw.trim(),h=HDR.exec(line);
      if(!line){if(cur&&cur.lines.length)flush();return;}
      if(h){
        flush();
        var t=TYPE[h[1].toLowerCase().replace(/[- ]/g,'')];
        cur={type:t,name:t+(h[2]?' '+h[2]:''),explicit:true,repeat:h[3]?+h[3]:1,lines:[]};
        return;
      }
      if(!cur)cur={type:null,name:null,explicit:false,repeat:1,lines:[]};
      cur.lines.push(line);
    });
    flush();
    if(!blocks.length)return [];
    if(blocks.every(function(b){return !b.explicit;})){
      var counts={};
      blocks.forEach(function(b){var k=norm(b.lines.join(' '));counts[k]=(counts[k]||0)+1;});
      var vn=0,sawChorus=false,bridged=false;
      blocks.forEach(function(b,i){
        var k=norm(b.lines.join(' '));
        if(counts[k]>1){b.type='Chorus';b.name='Chorus';sawChorus=true;}
        else if(sawChorus&&!bridged&&i>=blocks.length/2){b.type='Bridge';b.name='Bridge';bridged=true;}
        else{vn++;b.type='Verse';b.name='Verse '+vn;}
      });
    } else {
      blocks.forEach(function(b){if(!b.type){b.type='Verse';b.name='Verse';}});
      var vn=0;
      blocks.forEach(function(b){if(b.type==='Verse'&&b.name==='Verse'){vn++;b.name='Verse '+vn;}else if(b.type==='Verse'){vn=parseInt(b.name.split(' ')[1],10)||vn+1;}});
    }
    // de-duplicate repeated choruses: keep one lyric block per distinct text
    var seen={},out=[];
    blocks.forEach(function(b){
      var k=b.name+'|'+norm(b.lines.join(' '));
      if(seen[k])return;seen[k]=1;out.push(b);
    });
    return out;
  }

  // ---------- section labeling ----------
  function label(A,words){
    var bars=A.bars,segs=A.segments.map(function(s){return {start:s.start,end:s.end,cluster:s.cluster};});
    var known=!!(words&&words.length);
    // sung phrases stay whole: each goes to the section holding its midpoint, so a pickup
    // ("Never gonna | give you up") moves with the line it belongs to
    var phrases=[];
    if(known)words.forEach(function(w,i){
      var p=phrases[phrases.length-1],prev=words[i-1];
      if(!p||w.br||w.start-prev.end>0.6||p.length>=10||(/[.!?,;]$/.test(prev.text)&&p.length>=4))phrases.push([w]);else p.push(w);
    });
    if(known){var lastT=bars[bars.length-1].end,firstT=bars[0].start;
      phrases.forEach(function(ph){var mid=(ph[0].start+ph[ph.length-1].end)/2;if(mid>=lastT)ph.forEach(function(w){w.start=Math.min(w.start,lastT-0.2);w.end=Math.min(w.end,lastT-0.1);});if(mid<firstT)ph.forEach(function(w){w.start=Math.max(w.start,firstT);});});}
    segs.forEach(function(sg){
      sg.t0=bars[sg.start].start;sg.t1=bars[sg.end-1].end;sg.len=sg.end-sg.start;
      var r=0;for(var b=sg.start;b<sg.end;b++)r+=bars[b].rms;
      sg.db=20*Math.log10(r/sg.len+1e-6);
      sg.words=known?phrases.filter(function(ph){var mid=(ph[0].start+ph[ph.length-1].end)/2;return mid>=sg.t0&&mid<sg.t1;})
        .reduce(function(a,ph){return a.concat(ph);},[]):null;
      sg.vocal=known?sg.words.length>=3:null;
    });
    var dbs=segs.map(function(s){return s.db;}).sort(function(a,b){return a-b;});
    function rank(db){return dbs.length>1?dbs.indexOf(db)/(dbs.length-1):0.5;}
    var count={};segs.forEach(function(s){count[s.cluster]=(count[s.cluster]||0)+1;});
    var n=segs.length;
    if(n>1){
      var f=segs[0];
      if(known?!f.vocal:(count[f.cluster]===1||rank(f.db)<0.35||f.len<=4))f.label='Intro';
      var l=segs[n-1];
      if(known?!l.vocal:((count[l.cluster]===1&&rank(l.db)<0.5)||(f.label&&l.cluster===f.cluster)))l.label='Outro';
    }
    segs.forEach(function(s,i){
      if(s.label)return;
      if(known&&!s.vocal)s.label=s.len>=8?'Instrumental':'Turnaround';
      else if(!known&&s.len<=2&&i>0&&i<n-1)s.label='Turnaround';
    });
    // With lyrics, the chorus is the section whose words come back: group vocal sections by
    // shared words and call the biggest repeating group the chorus.
    var lyricChorus=false;
    if(known){
      var voc=segs.filter(function(s){return !s.label&&s.vocal;}),groups=[],best=null;
      voc.forEach(function(a){
        var grp=voc.filter(function(b){return b===a||jaccard(wordsText(a.words),wordsText(b.words))>=0.45;});
        if(grp.length<2||groups.some(function(g){return g.indexOf(a)>-1;}))return;
        grp.e=grp.reduce(function(t,x){return t+rank(x.db);},0)/grp.length;
        groups.push(grp);
        if(!best||grp.length>best.length||(grp.length===best.length&&grp.e>best.e))best=grp;
      });
      if(best){
        // a second repeating group that always sits right next to the chorus is the rest of it
        var mark=function(g){g.forEach(function(x){x.label='Chorus';x.lyricChorus=true;});};
        mark(best);
        groups.forEach(function(g){
          if(g===best)return;
          if(g.every(function(x){var i=segs.indexOf(x);return (segs[i-1]&&segs[i-1].lyricChorus)||(segs[i+1]&&segs[i+1].lyricChorus);}))mark(g);
        });
        // a neighbour made mostly of chorus words is part of the chorus too
        var cw={};segs.forEach(function(x){if(x.lyricChorus)norm(wordsText(x.words)).split(' ').forEach(function(w){if(w)cw[w]=1;});});
        for(var pass=0;pass<2;pass++)segs.forEach(function(x,i){
          if(x.label||!x.vocal)return;
          if(!((segs[i-1]&&segs[i-1].lyricChorus)||(segs[i+1]&&segs[i+1].lyricChorus)))return;
          var ws=norm(wordsText(x.words)).split(' ').filter(Boolean),hit=ws.filter(function(w){return cw[w];}).length;
          if(ws.length&&hit/ws.length>=0.7){x.label='Chorus';x.lyricChorus=true;}
        });
        lyricChorus=true;
      }
    }
    var stats={};
    segs.forEach(function(s,i){
      if(s.label)return;
      var st=stats[s.cluster]||(stats[s.cluster]={c:s.cluster,count:0,e:0,first:i,len:s.len});
      st.count++;st.e+=rank(s.db);
    });
    var cl=Object.keys(stats).map(function(k){var s=stats[k];s.e/=s.count;return s;});
    var chorus=null,verse=null;
    var rep=cl.filter(function(s){return s.count>=2;});
    if(!lyricChorus)(rep.length?rep:cl).forEach(function(s){if(!chorus||s.e+0.15*s.count>chorus.e+0.15*chorus.count)chorus=s;});
    function isChorus(x){return x&&(x.label==='Chorus'||(chorus&&x.cluster===chorus.c));}
    cl.filter(function(s){return s!==chorus;}).sort(function(a,b){return (b.count>=2)-(a.count>=2)||a.first-b.first;}).slice(0,1).forEach(function(s){verse=s;});
    if(verse&&chorus&&verse.count<2&&verse.first>chorus.first&&segs[verse.first].t0>A.duration*0.45)verse=null;
    var bridgeUsed=false;
    cl.forEach(function(s){
      if(s===chorus){s.label='Chorus';return;}
      if(s===verse){s.label='Verse';return;}
      var occ=segs.filter(function(x){return !x.label&&x.cluster===s.c;});
      var pre=s.count>=2&&s.len<=8&&occ.every(function(x){return isChorus(segs[segs.indexOf(x)+1]);});
      if(pre){s.label='Pre-Chorus';return;}
      var t=segs[s.first].t0;
      if(t>A.duration*0.45){
        var after=segs.slice(0,s.first).some(isChorus);
        if(s.len<=4&&s.first>=n-2)s.label='Tag';
        else if(!bridgeUsed||after){s.label=bridgeUsed?'Bridge 2':'Bridge';bridgeUsed=true;}
        else s.label='Bridge';
      } else s.label='Verse';
    });
    segs.forEach(function(s){if(!s.label)s.label=stats[s.cluster].label||'Verse';});
    return segs;
  }

  // ---------- section labeling from lyrics ----------
  // The analysis cuts the song into phrases (usually 4 bars). With lyrics, sections are found
  // from what repeats: the chorus is the run of phrases whose words and chords both come back,
  // and the most of the song it covers wins. Sung material between choruses is a verse (or a
  // bridge late in the song when its chords are new), and instrumental gaps are the intro,
  // turnarounds, interludes and outro.
  var VOCABLE=/^(oh+|o+h|ooh+|ah+|whoa+|woah+|yeah+|hey|la+|na+|mm+|hmm+|uh+|eh+|ho+)$/;
  function chordRoot(c){var m=/^([A-G][#b]?)(m(?!aj))?/.exec(c||'');return m?m[1]+(m[2]||''):'N';}
  function labelLyrics(A,words){
    // compare like with like: long segments are cut into 4 bar phrases
    var bars=A.bars,segs=[];
    A.segments.forEach(function(s){
      var L=s.end-s.start;
      if(L>=8&&L%4===0)for(var b=s.start;b<s.end;b+=4)segs.push({start:b,end:b+4});
      else segs.push({start:s.start,end:s.end});
    });
    var known=!!(words&&words.length);words=words||[];
    assignWords(bars,segs,words);
    // for comparing sections, each word counts where it is sung (a pickup half a beat early
    // counts with what follows); whole lines are kept together only for display
    var half=0.5*(A.beatDur||0.5);
    segs.forEach(function(sg){
      var t0=bars[sg.start].start,t1=bars[sg.end-1].end;
      var ws=words.filter(function(w){var t=w.start+half;return t>=t0&&t<t1;}).map(function(w){return norm(w.text);}).filter(Boolean);
      // each bar as the set of chords in it (root and minor only: G#m7 and G#m are the same here)
      sg.tokens=[];for(var b=sg.start;b<sg.end;b++)sg.tokens.push(bars[b].chords.map(function(c){return chordRoot(c.chord);}).filter(function(t,i,all){return all.indexOf(t)===i;}));
      // words compared by their first four letters, so "desert" and "deserve" still match
      sg.bag={};ws.forEach(function(w){if(!VOCABLE.test(w))sg.bag[w.replace(/'/g,'').slice(0,4)]=1;});
      sg.vocable=ws.length>=3&&ws.filter(function(w){return VOCABLE.test(w);}).length>=0.6*ws.length;
      // sung means words in the body of the phrase, not just the tail of the line before or
      // the pickup into the next one
      var d=t1-t0,body=words.filter(function(w){return w.start>=t0+0.1*d&&w.start<t1-0.2*d;}).length;
      sg.vocal=ws.length>=3&&body>=2;
      var r=0;for(var b=sg.start;b<sg.end;b++)r+=bars[b].rms;
      sg.db=20*Math.log10(r/(sg.end-sg.start)+1e-6);
    });
    // Without lyrics every phrase may be sung, except a quiet stretch at the start or end, and
    // sections are told apart by their chords and how loud they are.
    var dbs=segs.map(function(s){return s.db;}).sort(function(a,b){return a-b;}),med=dbs[dbs.length>>1];
    function rank(s){return dbs.length>1?dbs.indexOf(s.db)/(dbs.length-1):0.5;}
    if(!known){
      segs.forEach(function(s){s.vocal=true;});
      for(var i=0;i<segs.length-1&&segs[i].db<med-5;i++)segs[i].vocal=false;
      for(var i=segs.length-1;i>0&&segs[i].db<med-5;i--)segs[i].vocal=false;
      // a short phrase on one chord between sections is a turnaround
      segs.forEach(function(s){
        var all=[].concat.apply([],s.tokens);
        if(s.end-s.start<=4&&all.every(function(t){return t===all[0];}))s.vocal=false;
      });
    }
    function chordSim(a,b){
      var n=Math.min(a.tokens.length,b.tokens.length),hit=0;
      for(var i=0;i<n;i++){
        var x=a.tokens[i],y=b.tokens[i],c=x.filter(function(t){return y.indexOf(t)>-1;}).length;
        hit+=c/(x.length+y.length-c);
      }
      return hit/Math.max(a.tokens.length,b.tokens.length);
    }
    function lyricSim(a,b){
      var u=0,i=0;Object.keys(a.bag).forEach(function(w){u++;if(b.bag[w])i++;});
      Object.keys(b.bag).forEach(function(w){if(!a.bag[w])u++;});
      return u?i/u:(a.vocable&&b.vocable?1:0);
    }
    function same(a,b){
      if(a===b)return true;
      if(!a||!b||a.vocal!==b.vocal)return false;
      if(!a.vocal)return chordSim(a,b)>=0.75;
      if(!known)return chordSim(a,b)>=0.6;
      var l=lyricSim(a,b);
      return l>=0.45||(l>=0.3&&chordSim(a,b)>=0.5);
    }
    var n=segs.length;
    // every run of L phrases starting at i that comes back, with its non-overlapping occurrences
    function occurrences(i,L,free){
      var occ=[];
      for(var j=0;j+L<=n;j++){
        if(occ.length&&j<occ[occ.length-1]+L)continue;
        var ok=true,sung=0;
        for(var k=0;k<L&&ok;k++){
          var a=segs[i+k],b=segs[j+k];
          ok=(!free||!b.label)&&!b.vocable&&!a.vocable;
          if(ok)ok=a.vocal&&b.vocal&&same(a,b),sung++;
        }
        if(ok&&sung)occ.push(j);
      }
      return occ;
    }
    function barsOf(i,L){return segs[i+L-1].end-segs[i].start;}
    // A run must not start with a phrase that also turns up elsewhere followed by something
    // else (a line that closes every verse is not the start of the chorus), nor end with one
    // that turns up elsewhere after something else.
    function near(a,b){return !!a&&!!b&&(known&&a.vocal&&b.vocal?lyricSim(a,b)>=0.2:chordSim(a,b)>=0.5);}
    function clean(i,L,occ){
      if(L<2)return true;
      var head=occurrences(i,1,false),tail=occurrences(i+L-1,1,false);
      var badH=head.filter(function(j){return occ.indexOf(j)<0&&!near(segs[j+1],segs[i+1]);}).length;
      var badT=tail.filter(function(j){return occ.indexOf(j-L+1)<0&&!near(segs[j-1],segs[i+L-2]);}).length;
      return badH<Math.max(2,occ.length/2)&&badT<Math.max(2,occ.length/2);
    }
    function bestRun(free,minBars){
      var best=null;
      for(var L=1;L<=(known?6:2);L++)for(var i=0;i+L<=n;i++){
        if(barsOf(i,L)<minBars)continue;
        var occ=occurrences(i,L,free);
        if(occ.length<2||!clean(i,L,occ))continue;
        var cover=occ.length*barsOf(i,L);
        // without lyrics the chorus is also the loudest thing that repeats
        if(!known){var e=0;occ.forEach(function(j){for(var k=0;k<L;k++)e+=rank(segs[j+k]);});cover*=Math.pow(e/(occ.length*L),2);}
        if(!best||cover>best.cover||(cover===best.cover&&occ.length>best.occ.length))best={i:i,L:L,occ:occ,cover:cover};
      }
      return best;
    }
    var ch=bestRun(false,8)||bestRun(false,1);
    function mark(run,L,name,cl){run.forEach(function(j){for(var k=0;k<L;k++){segs[j+k].label=name;segs[j+k].cluster=cl;segs[j+k].lyricChorus=/^Chorus/.test(name);}});}
    if(ch){
      // a chorus whose first part also comes back on its own is two choruses (Chorus 1, Chorus 2)
      var split=null;
      for(var p=ch.L-1;p>=1&&!split&&known;p--){
        var occ=occurrences(ch.i,p,false);
        if(occ.some(function(j){return ch.occ.indexOf(j)<0;}))split={p:p,occ:occ};
      }
      if(split){
        mark(split.occ,split.p,'Chorus 1','C1');
        ch.occ.forEach(function(j){for(var k=split.p;k<ch.L;k++){segs[j+k].label='Chorus 2';segs[j+k].cluster='C2';segs[j+k].lyricChorus=true;}});
      } else mark(ch.occ,ch.L,'Chorus','C');
    }
    function isCh(s){return s&&/^Chorus/.test(s.label||'');}
    // a sung phrase next to a chorus that matches one of the chorus's phrases is part of it
    // (the last chorus is often cut short or sung a little differently)
    for(var changed=known;changed;){
      changed=false;
      segs.forEach(function(s,i){
        if(s.label||!s.vocal||s.vocable||!(isCh(segs[i-1])||isCh(segs[i+1])))return;
        var c=segs.filter(function(x){return isCh(x)&&same(s,x);})[0];
        if(c){s.label=c.label;s.cluster=c.cluster;s.lyricChorus=true;changed=true;}
      });
    }
    // another repeating part that always comes right before a chorus is the pre-chorus
    for(var guard=0;guard<3;guard++){
      var r=bestRun(true,1);
      if(!r)break;
      var before=r.occ.every(function(j){return isCh(segs[j+r.L]);}),after=r.occ.every(function(j){return isCh(segs[j-1]);});
      if(before)mark(r.occ,r.L,'Pre-Chorus','PC'+guard);
      else if(after&&!segs.some(function(s){return s.label==='Chorus 2';}))mark(r.occ,r.L,'Post-Chorus','PO'+guard);
      else break;
    }
    var nCh=0;segs.forEach(function(s,i){if(isCh(s)&&!isCh(segs[i-1]))nCh++;s.chBefore=nCh;});
    var firstVocal=-1,lastVocal=-1;segs.forEach(function(s,i){if(s.vocal){if(firstVocal<0)firstVocal=i;lastVocal=i;}});
    var verseRuns=[];
    for(var i=0;i<n;){
      if(segs[i].label){i++;continue;}
      var j=i;while(j+1<n&&!segs[j+1].label&&segs[j+1].vocal===segs[i].vocal&&segs[j+1].vocable===segs[i].vocable)j++;
      var run=segs.slice(i,j+1),bl=segs[j].end-segs[i].start,lab;
      if(!segs[i].vocal){
        if(firstVocal<0||i<firstVocal)lab='Intro';
        else if(i>lastVocal)lab=bl<=2?'Ending':'Outro';
        else if(bl<=4)lab='Turnaround';
        else lab=run.every(function(s){return segs.some(function(c){return isCh(c)&&chordSim(s,c)>=0.75;});})?'Instrumental':'Interlude';
      } else if(segs[i].vocable)lab='Refrain';
      else{
        var known=run.some(function(s){return verseRuns.some(function(v){return v.some(function(x){return chordSim(s,x)>=0.5;});});});
        lab=segs[i].chBefore>=2&&!known&&verseRuns.length?'Bridge':'Verse';
        if(lab==='Verse')verseRuns.push(run);
      }
      run.forEach(function(s){s.label=lab;s.cluster=lab+i;});
      i=j+1;
    }
    // join each section's phrases into one segment
    var out=[];
    segs.forEach(function(s){
      var p=out[out.length-1];
      if(p&&p.label===s.label&&p.cluster===s.cluster&&!(isCh(s)&&p.end-p.start>=barsOf(ch.i,ch.L))){p.end=s.end;p.words=p.words.concat(s.words);return;}
      out.push({start:s.start,end:s.end,label:s.label,cluster:s.cluster,lyricChorus:s.lyricChorus,words:s.words.slice()});
    });
    out.forEach(function(sg){
      sg.t0=bars[sg.start].start;sg.t1=bars[sg.end-1].end;sg.len=sg.end-sg.start;
      var r=0;for(var b=sg.start;b<sg.end;b++)r+=bars[b].rms;
      sg.db=20*Math.log10(r/sg.len+1e-6);
    });
    return out;
  }
  // Sung phrases stay whole: each goes to the section holding its midpoint, so a pickup
  // ("Never gonna | give you up") moves with the line it belongs to.
  function assignWords(bars,segs,words){
    var phrases=[];
    words.forEach(function(w,i){
      var p=phrases[phrases.length-1],prev=words[i-1];
      if(!p||w.br||w.start-prev.end>0.6||p.length>=10||(/[.!?,;]$/.test(prev.text)&&p.length>=4))phrases.push([w]);else p.push(w);
    });
    var lastT=bars[bars.length-1].end,firstT=bars[0].start;
    phrases.forEach(function(ph){var mid=(ph[0].start+ph[ph.length-1].end)/2;if(mid>=lastT)ph.forEach(function(w){w.start=Math.min(w.start,lastT-0.2);w.end=Math.min(w.end,lastT-0.1);});if(mid<firstT)ph.forEach(function(w){w.start=Math.max(w.start,firstT);});});
    segs.forEach(function(sg){
      var t0=bars[sg.start].start,t1=bars[sg.end-1].end;
      sg.words=phrases.filter(function(ph){var mid=(ph[0].start+ph[ph.length-1].end)/2;return mid>=t0&&mid<t1;})
        .reduce(function(a,ph){return a.concat(ph);},[]);
    });
  }
  // Whisper sometimes gets stuck repeating a word ("oh, oh, oh..." hundreds of times) and makes
  // up words over the fade-out. Keep runs of the same word short and drop words past the music.
  function cleanWords(words,end){
    var out=[],run=0;
    (words||[]).forEach(function(w,i){
      if(end!=null&&w.start>end+1.5)return;
      var k=norm(w.text),p=out[out.length-1],q=words[i-1];
      run=p&&norm(p.text)===k&&q&&w.start-q.end<0.5?run+1:1;
      if(run>4||(run>1&&w.end-w.start<0.06))return;
      out.push(w);
    });
    return out;
  }

  function jaccard(a,b){
    var A={},B={},i=0,u=0;
    norm(a).split(' ').forEach(function(w){if(w)A[w]=1;});
    norm(b).split(' ').forEach(function(w){if(w)B[w]=1;});
    Object.keys(A).forEach(function(w){u++;if(B[w])i++;});
    Object.keys(B).forEach(function(w){if(!A[w])u++;});
    return u?i/u:1;
  }
  function wordsText(ws){return (ws||[]).map(function(w){return w.text;}).join(' ');}

  // Back-to-back segments of the same material join into one section. If the joined bars then
  // repeat exactly (same chords, and same lyrics when known), print one pass marked x2, x3...
  function merge(segs,bars,lyricLines){
    var out=[];
    segs.forEach(function(s){
      var p=out[out.length-1];
      if(p&&p.label===s.label&&(p.cluster===s.cluster||(p.lyricChorus&&s.lyricChorus))){
        p.parts.push(s);p.t1=s.t1;p.len+=s.len;if(p.words)p.words=p.words.concat(s.words);return;
      }
      s.parts=[s];s.repeat=1;out.push(s);
    });
    out.forEach(function(s){
      var idx=[];s.parts.forEach(function(p){for(var b=p.start;b<p.end;b++)idx.push(b);});
      var L=idx.length,lines=lyricLines[baseType(s.label)]||0,minP=lines?2*lines:4;
      s.idx=idx;s.unit=L;
      for(var P=minP;P<=L/2;P++){
        if(L%P)continue;
        var ok=true;
        for(var i=P;i<L&&ok;i++)if(bars[idx[i]].sig!==bars[idx[i%P]].sig)ok=false;
        if(ok&&s.words){
          var cut=bars[idx[P]].start,a=s.words.filter(function(w){return w.start<cut-0.15;}),z=s.words.filter(function(w){return w.start>=cut-0.15&&w.start<cut-0.15+(cut-s.t0);});
          ok=jaccard(wordsText(a),wordsText(z))>0.55;
        }
        if(ok){s.unit=P;s.repeat=L/P;break;}
      }
      var end=bars[idx[s.unit-1]].end;
      // a repeated section prints one pass, so keep the words of that pass; otherwise keep all
      s.firstWords=!s.words?null:s.unit<L?s.words.filter(function(w){return w.start<end-0.15;}):s.words;
    });
    return out;
  }

  // ---------- dynamics ----------
  function dynamics(secs,bars){
    var kmax=0,hmax=0;bars.forEach(function(b){if(b.kick>kmax)kmax=b.kick;if(b.high>hmax)hmax=b.high;});
    secs.forEach(function(s){
      var r=0,k=0,h=0,c=0;
      s.parts.forEach(function(p){for(var b=p.start;b<p.end;b++){r+=bars[b].rms;k+=bars[b].kick;h+=bars[b].high;c++;}});
      s.db=20*Math.log10(r/c+1e-6);
      s.drums=0.5*(kmax?k/c/kmax:0)+0.5*(hmax?h/c/hmax:0);
      var a=s.parts[0].start,z=s.parts[s.parts.length-1].end;
      var head=0,tail=0,w=Math.min(2,Math.floor((z-a)/2))||1;
      for(var i=0;i<w;i++){head+=bars[a+i].rms;tail+=bars[z-1-i].rms;}
      s.trend=20*Math.log10((tail+1e-6)/(head+1e-6));
    });
    var lo=Infinity,hi=-Infinity,dmax=0;
    secs.forEach(function(s){lo=Math.min(lo,s.db);hi=Math.max(hi,s.db);dmax=Math.max(dmax,s.drums);});
    secs.forEach(function(s,i){
      s.e=hi-lo>0.5?(s.db-lo)/(hi-lo):0.5;
      var drumsLow=dmax?s.drums/dmax<0.42:true,prev=secs[i-1];
      s.drumsLow=drumsLow;
      s.mark=s.e<0.15?'pp':s.e<0.33?'p':s.e<0.5?'mp':s.e<0.68?'mf':s.e<0.86?'f':'ff';
      var cues=[];
      if(drumsLow&&s.e<0.4&&(!prev||prev.drumsLow))cues.push(i===0?'Keys + pad':'No drums');
      else if(drumsLow&&prev&&!prev.drumsLow)cues.push('Drums out');
      else if(!drumsLow&&prev&&prev.drumsLow)cues.push('Drums in');
      if(prev&&s.e-prev.e<=-0.35)cues.push('Break down');
      if(s.trend>3.5)cues.push('Build');
      else if(s.trend<-3.5)cues.push(i===secs.length-1?'Fade out':'Pull back');
      if(s.e>=0.86&&cues.indexOf('Build')<0)cues.push('Full band');
      s.cue=cues.join(' · ');
    });
  }

  // ---------- content text ----------
  function chordEvents(bars,beatDur){
    var ev=[],last=null;
    bars.forEach(function(bar){bar.chords.forEach(function(c){
      if(c.chord!=='N'&&c.chord!==last)ev.push({t:bar.start+c.pos*beatDur,chord:c.chord});
      last=c.chord;
    });});
    return ev;
  }
  function barCell(bar){
    var cs=bar.chords.map(function(c){return c.chord==='N'?'N.C.':c.chord;});
    return cs.filter(function(c,i){return i===0||c!==cs[i-1];}).join(' ');
  }
  // Chords of an instrumental stretch, written the way the reference charts do: each change
  // once ("1 5 6m 4"), not every bar.
  function barLines(bars,per){
    per=per||8;var ch=[],out=[];
    bars.forEach(function(b){barCell(b).split(' ').forEach(function(c){if(c&&c!==ch[ch.length-1])ch.push(c);});});
    while(ch.length>1&&ch[0]==='N.C.')ch.shift();
    while(ch.length>1&&ch[ch.length-1]==='N.C.')ch.pop();
    for(var i=0;i<ch.length;i+=per)out.push('| '+ch.slice(i,i+per).join(' | ')+' |');
    return out;
  }
  function textFromWords(words,bars,beatDur){
    if(!words||!words.length)return barLines(bars).join('\n');
    var lines=[],cur=[],synced=words.some(function(w){return w.br;});
    var bl=bars.map(function(b){return b.end-b.start;}).sort(function(a,b){return a-b;})[bars.length>>1]||2;
    words.forEach(function(w){
      var p=cur[cur.length-1],gap=p?w.start-p.end:0;
      // a short breath inside a line (a held note) does not end it; a longer one, or one after
      // a line that has run a bar and a half, does
      var brk=p&&(synced?w.br:(gap>1||(gap>0.6&&p.end-cur[0].start>=1.5*bl)||cur.length>=10||(/[.!?;]$/.test(p.text)&&cur.length>=4)));
      if(brk){lines.push(cur);cur=[];}
      cur.push({text:w.text,start:w.start,end:w.end,chord:null});
    });
    if(cur.length)lines.push(cur);
    var flat=[];lines.forEach(function(l){l[0].lineStart=true;l.forEach(function(w){flat.push(w);});});
    var gapBars=lines.map(function(l,i){
      var from=i?lines[i-1][lines[i-1].length-1].end:-1,to=l[0].start+0.1;
      return bars.filter(function(b){return b.start>=from-0.05&&b.end<=to;});
    });
    var trailing=bars.filter(function(b){return b.start>=flat[flat.length-1].end-0.05;});
    function inGap(t){
      return gapBars.some(function(g,i){return (g.length>=(i?2:1))&&g.some(function(b){return t>=b.start&&t<b.end;});})||
        (trailing.length>=2&&trailing.some(function(b){return t>=b.start&&t<b.end;}));
    }
    var ev=chordEvents(bars,beatDur);
    ev.forEach(function(e){
      if(inGap(e.t))return;
      for(var i=0;i<flat.length;i++)if(flat[i].start>=e.t-0.25){
        // a change on a held note at the end of a line stays on that line instead of being overwritten
        if(i>0&&flat[i].lineStart&&flat[i].start-e.t>0.5)flat[i-1].after=e.chord;
        else flat[i].chord=e.chord;
        return;
      }
    });
    // the first line shows the chord it starts on; later lines only show changes
    if(!lines[0][0].chord){
      var t=lines[0][0].start+0.25,act=null;
      ev.forEach(function(e){if(e.t<=t)act=e.chord;});
      if(act)lines[0][0].chord=act;
    }
    // a change held over from the end of a line is shown once, at the start of the next line
    lines.forEach(function(l,i){
      var w=l[l.length-1],nx=lines[i+1];
      if(w.after&&nx&&!nx[0].chord){nx[0].chord=w.after;w.after=null;}
      else if(w.after&&nx&&nx[0].chord===w.after)w.after=null;
    });
    var out=[];
    lines.forEach(function(l,i){
      if(gapBars[i].length>=(i?2:1))barLines(gapBars[i]).forEach(function(x){out.push(x);});
      out.push(l.map(function(w){return (w.chord?'['+w.chord+']':'')+w.text+(w.after?' ['+w.after+']':'');}).join(' '));
    });
    if(trailing.length>=2)barLines(trailing).forEach(function(x){out.push(x);});
    return out.join('\n');
  }
  function textFromLines(lines,bars){
    if(!bars.length)return lines.join('\n');
    if(!lines.length)return barLines(bars).join('\n');
    var B=bars.length,L=lines.length,out=[],prev=null;
    for(var i=0;i<L;i++){
      var b0=Math.min(B-1,Math.round(i*B/L)),b1=Math.min(B,Math.max(b0+1,Math.round((i+1)*B/L)));
      var line=lines[i],starts=[];
      for(var c=0;c<line.length;c++)if(line[c]!==' '&&(c===0||line[c-1]===' '))starts.push(c);
      var used={},ins=[],nb=b1-b0,first=true;
      for(var b=b0;b<b1;b++){
        bars[b].chords.forEach(function(ch){
          if(ch.chord==='N')return;
          if(ch.chord===prev&&!first)return;
          var frac=((b-b0)+ch.pos/bars[b].beats)/nb,target=frac*line.length,k=0;
          for(var j=0;j<starts.length;j++)if(starts[j]<=target+1)k=j;
          while(k<starts.length&&used[k])k++;
          prev=ch.chord;first=false;
          if(k>=starts.length)return;
          used[k]=1;ins.push({at:starts[k],chord:ch.chord});
        });
      }
      ins.sort(function(a,b){return b.at-a.at;});
      ins.forEach(function(x){line=line.slice(0,x.at)+'['+x.chord+']'+line.slice(x.at);});
      out.push(line);
    }
    return out.join('\n');
  }

  function secBars(s,bars){return s.idx.slice(0,s.unit).map(function(i){return bars[i];});}

  function roadmap(sections){
    return sections.map(function(s){return abbr(s.name)+(s.repeat>1?' x'+s.repeat:'');}).join('  ');
  }

  // ---------- build ----------
  function build(A,opts){
    var words=opts.words||null,lyr=opts.lyrics?parseLyrics(opts.lyrics):[];
    var lyricLines={};
    lyr.forEach(function(b){lyricLines[b.type]=Math.max(lyricLines[b.type]||0,b.lines.length);});
    if(words&&words.length)words=cleanWords(words,A.bars[A.bars.length-1].end);
    var segs=merge(labelLyrics(A,words),A.bars,lyricLines);
    dynamics(segs,A.bars);
    var vn=0;
    segs.forEach(function(s){
      s.name=s.label;
      if(s.label==='Verse'){vn++;s.name='Verse '+vn;}
    });
    if(lyr.length){
      var byType={},cnt={},used=[];
      lyr.forEach(function(b){(byType[b.type]=byType[b.type]||[]).push(b);});
      segs.forEach(function(s){
        var t=baseType(s.label),list=byType[t];
        if(!list||!list.length||/Intro|Outro|Instrumental|Turnaround/.test(t))return;
        var i=cnt[t]||0;cnt[t]=i+1;
        var b=t==='Verse'?list[i]:list[i%list.length];
        if(!b)return;
        s.lyric=b;if(used.indexOf(b)<0)used.push(b);
        if(b.explicit||t!=='Verse')s.name=b.name;
      });
      var left=lyr.filter(function(b){return used.indexOf(b)<0;});
      segs.forEach(function(s){
        if(s.lyric||!left.length||/Intro|Outro|Instrumental|Turnaround/.test(s.label))return;
        s.lyric=left.shift();s.name=s.lyric.name;
      });
      left.forEach(function(b){segs.push({name:b.name,label:b.type,lyric:b,repeat:1,parts:[],extra:true,mark:'',cue:''});});
    }
    var cache={};
    var sections=segs.map(function(s,si){
      var text;
      if(s.extra)text=s.lyric.lines.join('\n');
      else{
        var bars=secBars(s,A.bars);
        var key=baseType(s.name)+'|'+s.cluster+'|'+(s.lyric?lyr.indexOf(s.lyric):(words&&s.label==='Verse'?'seg'+si:''));
        if(cache[key]!=null)text=cache[key];
        else{
          if(s.lyric)text=textFromLines(s.lyric.lines,bars);
          // instrumental sections show chords only; a sung "oh" refrain shows its chords and a cue
          else if(words&&/^(Intro|Turnaround|Interlude|Instrumental|Outro|Ending)$/.test(s.label))text=barLines(bars).join('\n');
          else if(words&&s.label==='Refrain'){
            var voc=(s.firstWords||[]).map(function(w){return w.text.replace(/[^A-Za-z']/g,'');}).filter(Boolean);
            text=barLines(bars).join('\n')+(voc.length?'\n('+voc[0].charAt(0).toUpperCase()+voc[0].slice(1).toLowerCase()+')':'');
          }
          else if(words)text=textFromWords(s.firstWords,bars,A.beatDur);
          else text=barLines(bars).join('\n');
          cache[key]=text;
        }
      }
      var t0=s.t0,t1=s.t1;
      return {name:s.name,repeat:s.repeat||1,mark:s.mark||'',cue:s.cue||'',text:text,
        info:s.extra?'Lyrics not matched to audio':(s.unit+' bars · '+fmt(t0)+' to '+fmt(t1))};
    });
    return {title:opts.title||'',artist:opts.artist||'',key:A.key,tempo:A.bpm,time:A.time,
      roadmap:roadmap(sections),notes:opts.notes||'',notation:'numbers',columns:2,size:'M',condense:false,sections:sections};
  }
  function fmt(t){if(t==null)return '';var m=Math.floor(t/60),s=Math.round(t%60);if(s===60){m++;s=0;}return m+':'+(s<10?'0':'')+s;}

  // ---------- lyric transcription (Whisper in the browser) ----------
  var TF_URL='https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2';
  // Whisper listens to 30 second windows. A window that is all instrumental comes back as
  // "[Music]", so the window slides on 10 seconds and listens again; otherwise it moves on to
  // the end of the last word it kept. (The library's own long-audio chunking drops verses that
  // follow an instrumental intro.)
  async function transcribe(pcm16,report){
    var T=await import(TF_URL);
    var files={};
    function onProg(p){
      if(p.status==='progress'&&p.file){
        files[p.file]=[p.loaded||0,p.total||0];
        var l=0,t=0;Object.keys(files).forEach(function(k){l+=files[k][0];t+=files[k][1];});
        if(t)report('lyrics',0.3*l/t,'Downloading speech model '+Math.round(100*l/t)+'%');
      }
    }
    // Phones and tablets get Whisper tiny (64 MB): base (140 MB) runs them out of memory and the
    // browser reloads the page. Computers use base, on the graphics chip when available.
    var small=smallDevice(),model=small?'Xenova/whisper-tiny.en':'Xenova/whisper-base.en';
    function load(device){
      return T.pipeline('automatic-speech-recognition',model,
        {device:device,dtype:{encoder_model:'fp32',decoder_model_merged:device==='webgpu'?'q4':'q8'},progress_callback:onProg});
    }
    var asr=null;
    if(navigator.gpu&&!small){try{asr=await load('webgpu');await asr(new Float32Array(16000));}catch(e){asr=null;}}
    if(!asr)asr=await load('wasm');
    var SR=16000,WIN=30*SR,words=[],pos=0;
    function junk(w){return !w||/^[\[(♪*]|[\])♪]$/.test(w)||/^(music|applause|instrumental)$/i.test(w);}
    while(pos<pcm16.length-SR){
      report('lyrics',0.3+0.7*pos/pcm16.length,'Listening for lyrics. Longer songs can take a few minutes.');
      var win=pcm16.slice(pos,Math.min(pcm16.length,pos+WIN)),r;
      try{r=await asr(win,{return_timestamps:'word'});}
      catch(e){r=await asr(win,{return_timestamps:true});}
      var got=[];
      (r.chunks||[]).forEach(function(c){
        var ts=c.timestamp||[],st=ts[0],en=ts[1]!=null?ts[1]:st+0.4,parts=(c.text||'').trim().split(/\s+/).filter(Boolean);
        if(st==null)return;
        parts.forEach(function(w,i){got.push({text:w,start:st+(en-st)*i/parts.length,end:st+(en-st)*(i+1)/parts.length});});
      });
      var last=pos+WIN>=pcm16.length;
      var keep=got.filter(function(w){return !junk(w.text)&&(last||w.start<26);});
      if(!keep.length){pos+=10*SR;continue;}
      keep.forEach(function(w){
        // a word after a long instrumental gets stretched back to the window start; keep it short
        words.push({text:w.text,start:pos/SR+Math.max(w.start,w.end-1.2),end:pos/SR+w.end});
      });
      if(last)break;
      pos+=Math.max(5*SR,Math.round(keep[keep.length-1].end*SR));
    }
    // free the model's memory now that the lyrics are done
    try{if(asr.dispose)await asr.dispose();}catch(e){}
    return words;
  }
  function smallDevice(){
    var ua=navigator.userAgent||'';
    if(navigator.userAgentData&&navigator.userAgentData.mobile)return true;
    if(/iPhone|iPad|iPod|Android/i.test(ua))return true;
    if(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1)return true;  // iPad in desktop mode
    return !!(navigator.deviceMemory&&navigator.deviceMemory<=4);
  }

  function abbr(name){
    var t=baseType(name),num=(/\d+$/.exec(name||'')||[''])[0];
    return (ABBR[t]||(name||'?').slice(0,2))+num;
  }

  return {build:build,parseLyrics:parseLyrics,roadmap:roadmap,transcribe:transcribe,baseType:baseType,abbr:abbr};
})();
