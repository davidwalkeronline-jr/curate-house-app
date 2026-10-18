// =================== CHORD CHART BUILDER: AUDIO ANALYSIS ===================
// Everything runs in the browser: STFT -> chroma/onsets -> tempo + beat tracking ->
// key + chord recognition (Viterbi) -> bars -> structure segmentation -> dynamics.
var CBA=(function(){
  var SR=11025,N=4096,HOP=256,HALF=N/2;
  var FR=SR/HOP;
  function tick(){return new Promise(function(r){setTimeout(r,0);});}

  function decode(arrayBuf){
    var AC=window.AudioContext||window.webkitAudioContext;
    var ctx=new AC();
    return new Promise(function(res,rej){
      var p=ctx.decodeAudioData(arrayBuf,res,rej);
      if(p&&p.then)p.then(res,rej);
    }).then(function(buf){if(ctx.close)ctx.close();return buf;});
  }
  function resample(buf,rate){
    var len=Math.max(1,Math.ceil(buf.duration*rate));
    var OC=window.OfflineAudioContext||window.webkitOfflineAudioContext;
    var oc=new OC(1,len,rate);
    var src=oc.createBufferSource();
    src.buffer=buf;src.connect(oc.destination);src.start(0);
    return oc.startRendering().then(function(r){return r.getChannelData(0).slice();});
  }

  // ---------- FFT ----------
  var COS=new Float64Array(HALF),SIN=new Float64Array(HALF),REV=new Uint32Array(N);
  (function(){
    for(var i=0;i<HALF;i++){COS[i]=Math.cos(-2*Math.PI*i/N);SIN[i]=Math.sin(-2*Math.PI*i/N);}
    var bits=Math.log2(N);
    for(var i=0;i<N;i++){var r=0,x=i;for(var b=0;b<bits;b++){r=(r<<1)|(x&1);x>>=1;}REV[i]=r;}
  })();
  function fft(re,im){
    for(var i=0;i<N;i++){var j=REV[i];if(i<j){var t=re[i];re[i]=re[j];re[j]=t;t=im[i];im[i]=im[j];im[j]=t;}}
    for(var len=2;len<=N;len<<=1){
      var h=len>>1,step=N/len;
      for(var i=0;i<N;i+=len){
        for(var k=0;k<h;k++){
          var a=i+k,b=a+h,wr=COS[k*step],wi=SIN[k*step];
          var tr=re[b]*wr-im[b]*wi,ti=re[b]*wi+im[b]*wr;
          re[b]=re[a]-tr;im[b]=im[a]-ti;re[a]+=tr;im[a]+=ti;
        }
      }
    }
  }

  // ---------- frame features ----------
  async function frameFeatures(x,progress){
    var nF=Math.max(1,Math.floor((x.length-N)/HOP)+1);
    var win=new Float32Array(N);
    for(var i=0;i<N;i++)win[i]=0.5-0.5*Math.cos(2*Math.PI*i/(N-1));
    var binPc=new Int8Array(HALF).fill(-1),binW=new Float32Array(HALF);
    var bassPc=new Int8Array(HALF).fill(-1),bassW=new Float32Array(HALF);
    for(var k=1;k<HALF;k++){
      var f=k*SR/N,midi=69+12*Math.log2(f/440),r=Math.round(midi),d=Math.abs(midi-r);
      var w=Math.pow(Math.cos(Math.PI*d),2);
      if(f>=80&&f<=2000){binPc[k]=((r%12)+12)%12;binW[k]=w;}
      if(f>=38&&f<=200){bassPc[k]=((r%12)+12)%12;bassW[k]=w;}
    }
    var kLo=Math.round(40*N/SR),kHi=Math.round(150*N/SR),hLo=Math.round(2500*N/SR),hHi=Math.round(5200*N/SR),fHi=Math.round(5200*N/SR);
    var chroma=new Float32Array(nF*12),bass=new Float32Array(nF*12);
    var rms=new Float32Array(nF),flux=new Float32Array(nF),kick=new Float32Array(nF),high=new Float32Array(nF);
    var re=new Float64Array(N),im=new Float64Array(N),prev=new Float32Array(HALF),L=new Float32Array(HALF);
    for(var t=0;t<nF;t++){
      var s=t*HOP,e2=0;
      for(var i=0;i<N;i++){var v=x[s+i]||0;e2+=v*v;re[i]=v*win[i];im[i]=0;}
      rms[t]=Math.sqrt(e2/N);
      fft(re,im);
      var fl=0,kf=0,hf=0,o=t*12;
      for(var k=1;k<HALF;k++){
        var mag=Math.sqrt(re[k]*re[k]+im[k]*im[k])*4/N;
        var lv=Math.log(1+1000*mag);L[k]=lv;
        if(binPc[k]>=0)chroma[o+binPc[k]]+=binW[k]*lv;
        if(bassPc[k]>=0)bass[o+bassPc[k]]+=bassW[k]*lv;
        var dv=lv-prev[k];
        if(dv>0&&k<=fHi){fl+=dv;if(k>=kLo&&k<=kHi)kf+=dv;if(k>=hLo&&k<=hHi)hf+=dv;}
      }
      flux[t]=t?fl:0;kick[t]=t?kf:0;high[t]=t?hf:0;
      var tmp=prev;prev=L;L=tmp;
      if(t%300===0){progress(t/nF);await tick();}
    }
    return {nF:nF,chroma:chroma,bass:bass,rms:rms,flux:flux,kick:kick,high:high};
  }

  // ---------- tempo + beats (autocorrelation, then Ellis-style dynamic programming) ----------
  function onsetEnvelope(flux){
    var n=flux.length,o=new Float32Array(n),w=Math.round(FR*0.4),pre=new Float64Array(n+1);
    for(var i=0;i<n;i++)pre[i+1]=pre[i]+flux[i];
    var sum=0,sq=0;
    for(var i=0;i<n;i++){
      var a=Math.max(0,i-w),b=Math.min(n,i+w+1),m=(pre[b]-pre[a])/(b-a);
      o[i]=Math.max(0,flux[i]-m);sum+=o[i];sq+=o[i]*o[i];
    }
    var sd=Math.sqrt(Math.max(1e-9,sq/n-(sum/n)*(sum/n)));
    for(var i=0;i<n;i++)o[i]/=sd;
    return o;
  }
  function estimateTempo(o){
    var n=o.length,minLag=Math.floor(60*FR/200),maxLag=Math.ceil(60*FR/50);
    var ac=new Float64Array(maxLag+2);
    for(var l=minLag-1;l<=maxLag+1;l++){var s=0;for(var i=0;i+l<n;i++)s+=o[i]*o[i+l];ac[l]=s/(n-l);}
    var best=-1,bl=minLag;
    for(var l=minLag;l<=maxLag;l++){
      var bpm=60*FR/l,wt=Math.exp(-0.5*Math.pow(Math.log2(bpm/100)/0.9,2));
      var v=ac[l]*wt;
      if(v>best){best=v;bl=l;}
    }
    var a=ac[bl-1],b=ac[bl],c=ac[bl+1],den=a-2*b+c,off=den?0.5*(a-c)/den:0;
    if(Math.abs(off)>1)off=0;
    var bpm=60*FR/(bl+off);
    while(bpm<60)bpm*=2;
    while(bpm>168)bpm/=2;
    return bpm;
  }
  function trackBeats(o,bpm){
    var n=o.length,P=60*FR/bpm,sig=Math.max(1,P/32),rad=Math.ceil(sig*3);
    var ls=new Float32Array(n);
    for(var i=0;i<n;i++){var s=0;for(var k=-rad;k<=rad;k++){var j=i+k;if(j>=0&&j<n)s+=o[j]*Math.exp(-0.5*k*k/(sig*sig));}ls[i]=s;}
    var score=new Float32Array(n),back=new Int32Array(n).fill(-1),tight=100;
    for(var i=0;i<n;i++){
      var lo=Math.max(0,Math.round(i-2*P)),hi=Math.round(i-P/2),best=-Infinity,bj=-1;
      for(var j=lo;j<=hi;j++){var v=score[j]-tight*Math.pow(Math.log((i-j)/P),2);if(v>best){best=v;bj=j;}}
      score[i]=ls[i]+(bj>=0?best:0);back[i]=bj;
    }
    var end=n-1,bs=-Infinity;
    for(var i=Math.max(0,Math.round(n-2*P));i<n;i++)if(score[i]>bs){bs=score[i];end=i;}
    var beats=[];
    for(var i=end;i>=0;i=back[i])beats.push(i);
    beats.reverse();
    return beats;
  }

  function syncMean(arr,dims,beats,nF){
    var nb=beats.length,out=new Float32Array(nb*dims);
    for(var b=0;b<nb;b++){
      var s=beats[b],e=b+1<nb?beats[b+1]:Math.min(nF,s+(s-(beats[b-1]||0))),cnt=Math.max(1,e-s);
      for(var t=s;t<e;t++)for(var d=0;d<dims;d++)out[b*dims+d]+=arr[t*dims+d];
      for(var d=0;d<dims;d++)out[b*dims+d]/=cnt;
    }
    return out;
  }

  // ---------- chords ----------
  var TEMPL=[];
  (function(){
    for(var r=0;r<12;r++)[[0,4,7],[0,3,7]].forEach(function(iv,q){
      var v=new Float32Array(12);
      iv.forEach(function(x,i){v[(r+x)%12]=i===0?1.1:1;});
      var m=0;for(var i=0;i<12;i++)m+=v[i];m/=12;
      var nn=0;for(var i=0;i<12;i++){v[i]-=m;nn+=v[i]*v[i];}nn=Math.sqrt(nn);
      for(var i=0;i<12;i++)v[i]/=nn;
      TEMPL[r*2+q]=v;
    });
  })();
  function centered(vec,o){
    var v=new Float32Array(12),m=0,nn=0;
    for(var i=0;i<12;i++)m+=vec[o+i];m/=12;
    for(var i=0;i<12;i++){v[i]=vec[o+i]-m;nn+=v[i]*v[i];}
    nn=Math.sqrt(nn)||1;for(var i=0;i<12;i++)v[i]/=nn;
    return v;
  }
  function corr(a,b){var s=0;for(var i=0;i<12;i++)s+=a[i]*b[i];return s;}

  var MAJ_PROF=[6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
  var MIN_PROF=[6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
  function profileKey(total){
    var c=centered(total,0),res=[];
    [MAJ_PROF,MIN_PROF].forEach(function(prof,minor){
      for(var k=0;k<12;k++){
        var p=new Float32Array(12);for(var i=0;i<12;i++)p[i]=prof[(i-k+12)%12];
        res.push({pc:k,minor:!!minor,score:corr(c,centered(p,0))});
      }
    });
    res.sort(function(a,b){return b.score-a.score;});
    return res;
  }
  function keyPrior(tonicMajor){
    var pri=new Float32Array(25).fill(-1.8),K=tonicMajor;
    function set(off,q,v){pri[((K+off)%12)*2+q]=v;}
    set(0,0,0.15);set(5,0,0);set(7,0,0);set(9,1,0);set(2,1,0);set(4,1,-0.2);
    set(10,0,-0.6);set(2,0,-0.9);set(4,0,-1.0);set(5,1,-1.0);set(8,0,-1.0);
    pri[24]=0;
    return pri;
  }
  function viterbi(emis,nb,pri,beatPos,meter){
    var S=25,BETA=7,score=new Float32Array(S),nsc=new Float32Array(S),back=new Uint8Array(nb*S);
    for(var s=0;s<S;s++)score[s]=BETA*emis[s]+(pri?pri[s]:0);
    for(var b=1;b<nb;b++){
      var pos=beatPos[b],pen=pos===0?2.5:(meter%2===0&&pos===meter/2?3.5:6);
      var bi=0;for(var s=1;s<S;s++)if(score[s]>score[bi])bi=s;
      for(var s=0;s<S;s++){
        var stay=score[s],sw=score[bi]-pen,v,from;
        if(stay>=sw){v=stay;from=s;}else{v=sw;from=bi;}
        nsc[s]=v+BETA*emis[b*S+s]+(pri?pri[s]:0);back[b*S+s]=from;
      }
      var t=score;score=nsc;nsc=t;
    }
    var path=new Array(nb),best=0;
    for(var s=1;s<S;s++)if(score[s]>score[best])best=s;
    for(var b=nb-1;b>=0;b--){path[b]=best;best=back[b*S+best];}
    return path;
  }
  function chordLabel(state,keyStr,bassPc){
    if(state===24)return 'N';
    var root=state>>1,minor=state&1;
    var name=CBT.spell(root,keyStr)+(minor?'m':'');
    if(bassPc!=null&&bassPc!==root)name+='/'+CBT.spell(bassPc,keyStr);
    return name;
  }

  // Recognized chord segments [[start, end, "C#:min7/G#"], ...] -> per beat: the label covering most of
  // the beat, plus a major/minor state (24 = no chord) used for key finding and downbeats.
  var PC={C:0,'C#':1,Db:1,D:2,'D#':3,Eb:3,E:4,F:5,'F#':6,Gb:6,G:7,'G#':8,Ab:8,A:9,'A#':10,Bb:10,B:11};
  var MINORISH={min:1,min7:1,min6:1,minmaj7:1,dim:1,dim7:1,hdim7:1};
  var SUFFIX={maj:'','min':'m','7':'7',maj7:'maj7',min7:'m7',maj6:'6',min6:'m6',sus2:'sus2',sus4:'sus4',
    dim:'dim',dim7:'dim7',hdim7:'m7b5',aug:'aug',minmaj7:'m(maj7)'};
  function parseSeg(label){
    var m=/^([A-G][#b]?):([^/]+)(?:\/([A-G][#b]?))?$/.exec(label||'');
    if(!m||PC[m[1]]==null)return null;
    return {root:PC[m[1]],qual:m[2],bass:m[3]!=null?PC[m[3]]:null};
  }
  function segmentPath(segs,beatTimes,beatDur){
    var nb=beatTimes.length,states=new Array(nb),labels=new Array(nb),j=0;
    for(var b=0;b<nb;b++){
      var t0=beatTimes[b],t1=b+1<nb?beatTimes[b+1]:t0+beatDur,ov={},best=null;
      while(j<segs.length&&segs[j][1]<=t0)j++;
      for(var k=j;k<segs.length&&segs[k][0]<t1;k++){
        var l=segs[k][2];ov[l]=(ov[l]||0)+Math.min(t1,segs[k][1])-Math.max(t0,segs[k][0]);
        if(best===null||ov[l]>ov[best])best=l;
      }
      var c=parseSeg(best);
      labels[b]=c;
      states[b]=c?c.root*2+(MINORISH[c.qual]?1:0):24;
    }
    return {states:states,labels:labels};
  }
  function segmentName(c,key){
    if(!c)return 'N';
    var suf=SUFFIX[c.qual]!=null?SUFFIX[c.qual]:c.qual;
    return CBT.spell(c.root,key)+suf+(c.bass!=null&&c.bass!==c.root?'/'+CBT.spell(c.bass,key):'');
  }

  // ---------- main ----------
  async function analyze(buf,opts,report){
    opts=opts||{};
    report('decode',0.5,'Resampling audio');
    var x=await resample(buf,SR);
    var peak=0;for(var i=0;i<x.length;i++){var a=Math.abs(x[i]);if(a>peak)peak=a;}
    if(peak>0)for(var i=0;i<x.length;i++)x[i]/=peak;
    report('decode',1);

    var F=await frameFeatures(x,function(p){report('features',p,'Listening '+Math.round(p*100)+'%');});
    report('features',1);await tick();

    var o=onsetEnvelope(F.flux);
    var bpm=estimateTempo(o);
    var beats=trackBeats(o,bpm);
    // Trim beats in leading/trailing silence.
    var maxR=0;for(var i=0;i<F.nF;i++)if(F.rms[i]>maxR)maxR=F.rms[i];
    while(beats.length>8&&F.rms[beats[0]]<0.03*maxR)beats.shift();
    while(beats.length>8&&F.rms[beats[beats.length-1]]<0.03*maxR)beats.pop();
    var ibis=[];for(var i=1;i<beats.length;i++)ibis.push(beats[i]-beats[i-1]);
    ibis.sort(function(a,b){return a-b;});
    if(ibis.length)bpm=60*FR/ibis[ibis.length>>1];
    var nb=beats.length;
    var beatTimes=beats.map(function(f){return (f*HOP+N/2)/SR;});
    var beatDur=60/bpm;
    report('tempo',1,Math.round(bpm)+' BPM');await tick();

    var bChroma=syncMean(F.chroma,12,beats,F.nF),bBass=syncMean(F.bass,12,beats,F.nF);
    var bRms=syncMean(F.rms,1,beats,F.nF),bKick=syncMean(F.kick,1,beats,F.nF),bHigh=syncMean(F.high,1,beats,F.nF);
    var maxBR=0;for(var b=0;b<nb;b++)if(bRms[b]>maxBR)maxBR=bRms[b];

    // emission scores: centered-chroma correlation with templates + bass support for the root
    var emis=new Float32Array(nb*25);
    var total=new Float32Array(12);
    for(var b=0;b<nb;b++){
      var c=centered(bChroma,b*12);
      var bm=0;for(var i=0;i<12;i++)if(bBass[b*12+i]>bm)bm=bBass[b*12+i];
      var silent=bRms[b]<0.04*maxBR;
      for(var s=0;s<24;s++){
        var r=s>>1;
        emis[b*25+s]=corr(c,TEMPL[s])+0.18*(bm?bBass[b*12+r]/bm:0)-(silent?1:0);
      }
      emis[b*25+24]=silent?0.6:-0.4;
      for(var i=0;i<12;i++)total[i]+=bChroma[b*12+i]*bRms[b];
    }

    // Chords from the trained model (crema, on the device) replace the template guesses below:
    // each beat takes the chord that covers most of it.
    var seg=opts.chords&&opts.chords.length?segmentPath(opts.chords,beatTimes,beatDur):null,given=seg&&seg.states;

    // meter + downbeat phase from where chord changes and bass hits land
    var change=new Float32Array(nb),kmax=0;
    for(var b=0;b<nb;b++)if(bKick[b]>kmax)kmax=bKick[b];
    for(var b=1;b<nb;b++){
      var ch=given?(given[b]!==given[b-1]?1:0):(1-corr(centered(bChroma,(b-1)*12),centered(bChroma,b*12)));
      change[b]=ch+0.3*(kmax?bKick[b]/kmax:0);
    }
    function phaseScore(m){
      var best={m:m,p:0,s:-Infinity},all=0;
      for(var b=1;b<nb;b++)all+=change[b];all/=Math.max(1,nb-1);
      for(var p=0;p<m;p++){var s=0,c=0;for(var b=p;b<nb;b+=m){if(b){s+=change[b];c++;}}s=c?s/c-all:0;if(s>best.s)best={m:m,p:p,s:s};}
      return best;
    }
    var m4=phaseScore(4),m3=phaseScore(3),meter;
    if(opts.time==='3/4'||opts.time==='6/8')meter=opts.time==='3/4'?m3:phaseScore(3);
    else if(opts.time==='4/4')meter=m4;
    else meter=(m3.s>m4.s*1.35&&m3.s>0.05)?m3:m4;
    var M=meter.m,phase=meter.p;
    var beatPos=new Int32Array(nb);for(var b=0;b<nb;b++)beatPos[b]=((b-phase)%M+M)%M;

    report('chords',0.2,'Finding the key');await tick();
    var path0=given||viterbi(emis,nb,null,beatPos,M);
    var prof=profileKey(total);
    var dur=new Float32Array(25);path0.forEach(function(s){dur[s]++;});
    var first=-1,last=-1;for(var b=0;b<nb;b++)if(path0[b]!==24){if(first<0)first=path0[b];last=path0[b];}
    var bestK=0,bestV=-Infinity,totalD=0;for(var s=0;s<24;s++)totalD+=dur[s];
    for(var K=0;K<12;K++){
      var dia=dur[K*2]+dur[((K+5)%12)*2]+dur[((K+7)%12)*2]+dur[((K+9)%12)*2+1]+dur[((K+2)%12)*2+1]+dur[((K+4)%12)*2+1];
      var v=1.3*dur[K*2]+dur[((K+5)%12)*2]+dur[((K+7)%12)*2]+dur[((K+9)%12)*2+1]+0.8*dur[((K+2)%12)*2+1]+0.5*dur[((K+4)%12)*2+1];
      // chords outside the key count against it, so the most frequent chord does not win by default
      v-=0.9*(totalD-dia);
      if(first===K*2)v+=0.12*totalD;
      if(last===K*2)v+=0.12*totalD;
      var pk=prof.filter(function(p){return !p.minor&&p.pc===K;})[0];
      v+=pk.score*0.15*totalD;
      if(v>bestV){bestV=v;bestK=K;}
    }
    var relMin=(bestK+9)%12,isMinor=false;
    var profMin=prof.filter(function(p){return p.minor&&p.pc===relMin;})[0],profMaj=prof.filter(function(p){return !p.minor&&p.pc===bestK;})[0];
    if(dur[relMin*2+1]>1.6*dur[bestK*2]&&profMin.score>profMaj.score+0.05)isMinor=true;
    var keyStr=isMinor?CBT.keyName(relMin,true):CBT.keyName(bestK,false);
    report('chords',0.6,'Key of '+keyStr);await tick();

    var path=given||viterbi(emis,nb,keyPrior(bestK),beatPos,M);
    // slash chords: bass on the chord's third, clearly louder than the root
    var labels=new Array(nb);
    if(seg)for(var b=0;b<nb;b++)labels[b]=segmentName(seg.labels[b],keyStr);
    else for(var b=0;b<nb;){
      var e=b;while(e+1<nb&&path[e+1]===path[b])e++;
      var st=path[b],bassPc=null;
      if(st!==24){
        var root=st>>1,third=(root+((st&1)?3:4))%12,acc=new Float32Array(12);
        for(var k=b;k<=e;k++)for(var i=0;i<12;i++)acc[i]+=bBass[k*12+i];
        var top=0;for(var i=1;i<12;i++)if(acc[i]>acc[top])top=i;
        if(top===third&&acc[third]>1.3*acc[root])bassPc=third;
      }
      var lab=chordLabel(st,keyStr,bassPc);
      for(var k=b;k<=e;k++)labels[k]=lab;
      b=e+1;
    }
    report('chords',1,'Key of '+keyStr);await tick();

    // ---------- bars ----------
    var bars=[];
    var starts=[];for(var b=phase;b<nb;b+=M)starts.push(b);
    if(!starts.length)starts=[0];
    if(starts[0]>0)starts[0]=0;
    for(var j=0;j<starts.length;j++){
      var s=starts[j],e=j+1<starts.length?starts[j+1]:nb;
      if(e<=s)continue;
      var runs=[];
      for(var b=s;b<e;b++){
        if(runs.length&&runs[runs.length-1].chord===labels[b])runs[runs.length-1].len++;
        else runs.push({chord:labels[b],pos:b-s,len:1});
      }
      var keep;
      if(runs.length<=2)keep=runs;
      else{
        var rest=runs.slice(1).sort(function(a,b2){return b2.len-a.len;})[0];
        keep=[runs[0],rest].sort(function(a,b2){return a.pos-b2.pos;});
        if(runs[0].len===1&&rest.len>=M-1)keep=[rest];
      }
      var cv=new Float32Array(12),bv=new Float32Array(12),rr=0,kk=0,hh=0;
      for(var b=s;b<e;b++){for(var i=0;i<12;i++){cv[i]+=bChroma[b*12+i];bv[i]+=bBass[b*12+i];}rr+=bRms[b];kk+=bKick[b];hh+=bHigh[b];}
      var n=e-s;
      bars.push({start:beatTimes[s],end:e<nb?beatTimes[e]:beatTimes[nb-1]+beatDur,beats:n,
        chords:keep.map(function(r){return {chord:r.chord,pos:r.pos};}),
        sig:runs.map(function(r){return r.chord;}).join(' '),
        chroma:centered(cv,0),rms:rr/n,kick:kk/n,high:hh/n});
    }
    // drop silent bars at the very start and end
    while(bars.length>2&&bars[0].chords.every(function(c){return c.chord==='N';}))bars.shift();
    while(bars.length>2&&bars[bars.length-1].chords.every(function(c){return c.chord==='N';}))bars.pop();

    report('structure',0.3,'Comparing sections');await tick();
    var segs=segmentStructure(bars);
    report('structure',1,segs.length+' sections');

    return {duration:buf.duration,bpm:Math.round(bpm),key:keyStr,meter:M,time:opts.time&&opts.time!=='auto'?opts.time:(M===3?'3/4':'4/4'),
      beatDur:beatDur,bars:bars,segments:segs};
  }

  // ---------- structure ----------
  function barSim(a,b){
    var c=Math.max(0,corr(a.chroma,b.chroma));
    var ca=a.chords.map(function(x){return x.chord;}),cb=b.chords.map(function(x){return x.chord;});
    var same=ca.join()===cb.join()?1:(ca.some(function(x){return cb.indexOf(x)>-1;})?0.4:0);
    return 0.55*c+0.45*same;
  }
  function segmentStructure(bars){
    var n=bars.length;
    if(n<4)return [{start:0,end:n,cluster:0}];
    var S=[];for(var i=0;i<n;i++){S.push(new Float32Array(n));}
    for(var i=0;i<n;i++)for(var j=i;j<n;j++){var v=barSim(bars[i],bars[j]);S[i][j]=v;S[j][i]=v;}
    var db=bars.map(function(b){return 20*Math.log10(b.rms+1e-6);});
    // Foote checkerboard novelty
    var K=4,nov=new Float32Array(n+1),mx=0,wFull=0;
    for(var u=-K;u<K;u++)for(var v=-K;v<K;v++)wFull+=Math.exp(-0.5*((u+0.5)*(u+0.5)+(v+0.5)*(v+0.5))/(K*K*0.5));
    for(var t=1;t<n;t++){
      var s=0;
      for(var u=-K;u<K;u++)for(var v=-K;v<K;v++){
        var i=t+u,j=t+v;if(i<0||j<0||i>=n||j>=n)continue;
        var sign=((u<0)===(v<0))?1:-1,g=Math.exp(-0.5*((u+0.5)*(u+0.5)+(v+0.5)*(v+0.5))/(K*K*0.5));
        s+=sign*g*S[i][j];
      }
      // dividing by the full kernel weight keeps partial windows at the song edges from spiking
      nov[t]=Math.max(0,s/wFull);if(nov[t]>mx)mx=nov[t];
    }
    for(var t=1;t<n;t++){
      var a=(db[t]+(db[t+1]!=null?db[t+1]:db[t]))/2,b=(db[t-1]+(db[t-2]!=null?db[t-2]:db[t-1]))/2;
      // most sections start on a 4 bar phrase boundary counted from the first bar
      nov[t]=0.65*(mx?nov[t]/mx:0)+0.35*Math.min(1,Math.abs(a-b)/5)+(t%4===0?0.15:0)+(t%8===0?0.05:0);
    }
    var LB={2:-0.45,4:0.25,6:-0.35,8:0.5,12:0.05,16:0.25},SEGP=0.35;
    var best=new Float32Array(n+1).fill(-Infinity),from=new Int32Array(n+1).fill(-1);best[0]=0;
    for(var j=1;j<=n;j++){
      for(var L=1;L<=16&&L<=j;L++){
        var i=j-L,bonus=LB[L];
        if(bonus==null){if(i===0||j===n)bonus=-0.3;else continue;}
        if(best[i]===-Infinity)continue;
        var v=best[i]+bonus-SEGP+(j<n?nov[j]*1.2:0.6);
        if(v>best[j]){best[j]=v;from[j]=i;}
      }
    }
    var cuts=[];for(var j=n;j>0;j=from[j]){if(from[j]<0){cuts=[0,n];break;}cuts.push(j);}
    if(cuts[cuts.length-1]!==0)cuts.push(0);
    cuts.reverse();
    var segs=[];for(var i=0;i+1<cuts.length;i++)segs.push({start:cuts[i],end:cuts[i+1]});
    if(segs.length>1&&segs[segs.length-1].end-segs[segs.length-1].start<=2){segs[segs.length-2].end=n;segs.pop();}
    // cluster repeated material
    function segSim(A,B){
      var la=A.end-A.start,lb=B.end-B.start,m=Math.min(la,lb),s=0;
      for(var k=0;k<m;k++)s+=S[A.start+k][B.start+k];
      s/=m;
      if(Math.min(la,lb)/Math.max(la,lb)<0.75)s*=0.85;
      return s;
    }
    var reps=[];
    segs.forEach(function(sg){
      var bi=-1,bv=0.66;
      reps.forEach(function(r,ci){var v=segSim(sg,r);if(v>bv){bv=v;bi=ci;}});
      if(bi<0){reps.push(sg);bi=reps.length-1;}
      sg.cluster=bi;
    });
    return segs;
  }

  // A mono 44.1 kHz copy of the song, so the decoded original (often stereo) can be released.
  async function toMono44(buf){
    if(buf.numberOfChannels===1&&buf.sampleRate===44100)return buf;
    var y=await resample(buf,44100),out;
    try{out=new AudioBuffer({length:y.length,numberOfChannels:1,sampleRate:44100});}
    catch(e){var OC=window.OfflineAudioContext||window.webkitOfflineAudioContext;out=new OC(1,1,44100).createBuffer(1,y.length,44100);}
    if(out.copyToChannel)out.copyToChannel(y,0);else out.getChannelData(0).set(y);
    return out;
  }

  return {decode:decode,resample:resample,toMono44:toMono44,analyze:analyze};
})();
