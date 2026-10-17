// =================== CHORD RECOGNITION ON THE DEVICE ===================
// A JavaScript port of the crema chord model (c) 2017 Brian McFee, BSD 2-Clause
// (see models/CREMA-LICENSE.md). It recognizes major, minor, sus2, sus4, 6th, 7th,
// diminished and augmented chords plus the bass note, so slash chords come out too.
// Pipeline: harmonic constant-Q spectrogram -> conv layers -> two bidirectional GRUs ->
// chord probabilities -> Viterbi smoothing -> bass note per chord.
var CBC=(function(){
  var MODEL_URL='models/crema-chord';
  var modelP=null;
  function tick(){return new Promise(function(r){setTimeout(r,0);});}

  function load(){
    if(!modelP)modelP=Promise.all([
      fetch(MODEL_URL+'.json').then(function(r){if(!r.ok)throw new Error('Chord model missing ('+r.status+')');return r.json();}),
      fetch(MODEL_URL+'.bin').then(function(r){if(!r.ok)throw new Error('Chord model missing ('+r.status+')');return r.arrayBuffer();})
    ]).then(function(res){
      var meta=res[0],data=new Float32Array(res[1]);
      meta.data=data;
      meta.t=function(name){var e=meta.tensors[name];return data.subarray(e.offset,e.offset+e.shape.reduce(function(a,b){return a*b;},1));};
      return meta;
    }).catch(function(e){modelP=null;throw e;});
    return modelP;
  }

  // ---------- real FFT (radix 2) ----------
  var fftCache={};
  function fftTables(n){
    if(fftCache[n])return fftCache[n];
    var c=new Float64Array(n/2),s=new Float64Array(n/2),rev=new Uint32Array(n),bits=Math.log2(n);
    for(var i=0;i<n/2;i++){c[i]=Math.cos(-2*Math.PI*i/n);s[i]=Math.sin(-2*Math.PI*i/n);}
    for(var i=0;i<n;i++){var r=0,x=i;for(var b=0;b<bits;b++){r=(r<<1)|(x&1);x>>=1;}rev[i]=r;}
    return (fftCache[n]={c:c,s:s,rev:rev});
  }
  function fft(re,im){
    var n=re.length,T=fftTables(n);
    for(var i=0;i<n;i++){var j=T.rev[i];if(i<j){var t=re[i];re[i]=re[j];re[j]=t;t=im[i];im[i]=im[j];im[j]=t;}}
    for(var len=2;len<=n;len<<=1){
      var h=len>>1,step=n/len;
      for(var i=0;i<n;i+=len)for(var k=0;k<h;k++){
        var a=i+k,b=a+h,wr=T.c[k*step],wi=T.s[k*step];
        var tr=re[b]*wr-im[b]*wi,ti=re[b]*wi+im[b]*wr;
        re[b]=re[a]-tr;im[b]=im[a]-ti;re[a]+=tr;im[a]+=ti;
      }
    }
  }

  // ---------- harmonic constant-Q spectrogram ----------
  // Half-band low-pass then decimate by two (stands in for librosa's resampler; same features in dB).
  var HB=(function(){
    var n=48,h=new Float64Array(2*n+1),sum=0;
    function i0(x){var s=1,t=1;for(var k=1;k<40;k++){t*=(x/(2*k))*(x/(2*k));s+=t;}return s;}
    for(var i=-n;i<=n;i++){
      var x=i*0.5*0.94,sinc=x===0?1:Math.sin(Math.PI*x)/(Math.PI*x);
      var w=i0(9*Math.sqrt(1-Math.pow(i/n,2)))/i0(9);
      h[i+n]=sinc*0.94*0.5*w;sum+=h[i+n];
    }
    for(var i=0;i<h.length;i++)h[i]/=sum;
    return h;
  })();
  function down2(x){
    var n=x.length,m=Math.ceil(n/2),out=new Float32Array(m),L=HB.length,c=(L-1)/2,g=Math.SQRT2;
    for(var o=0;o<m;o++){
      var center=2*o,s=0,a=Math.max(0,center-c),b=Math.min(n-1,center+c);
      for(var j=a;j<=b;j++)s+=x[j]*HB[center-j+c];
      out[o]=s*g;
    }
    return out;
  }
  function cqtHarmonic(y,octs,M,nFrames){
    var out=new Float32Array(nFrames*216),x=y,d=1;
    for(var oi=0;oi<octs.length;oi++){
      var o=octs[oi];
      while(d<o.down){x=down2(x);d*=2;}
      var n=o.n_fft,hop=o.hop,half=n/2,re=new Float64Array(n),im=new Float64Array(n);
      var rows=o.rows.map(function(r){return {s:r.start,n:r.n,re:M.data.subarray(r.re,r.re+r.n),im:M.data.subarray(r.im,r.im+r.n)};});
      var binBase=216-36*(oi+1);
      for(var t=0;t<nFrames;t++){
        var st=t*hop-half;
        for(var i=0;i<n;i++){var k=st+i;re[i]=k>=0&&k<x.length?x[k]:0;im[i]=0;}
        fft(re,im);
        for(var b=0;b<36;b++){
          var r=rows[b],sr=0,si=0;
          for(var j=0;j<r.n;j++){var q=r.s+j,wr=r.re[j],wi=r.im[j];sr+=wr*re[q]-wi*im[q];si+=wr*im[q]+wi*re[q];}
          out[t*216+binBase+b]=Math.sqrt(sr*sr+si*si);
        }
      }
    }
    // decibels relative to the loudest bin, floored at -80 dB (librosa amplitude_to_db, ref=max)
    var mx=1e-5;for(var i=0;i<out.length;i++)if(out[i]>mx)mx=out[i];
    var ref=20*Math.log10(mx);
    for(var i=0;i<out.length;i++)out[i]=Math.max(-80,20*Math.log10(Math.max(1e-5,out[i]))-ref);
    return out;
  }

  // ---------- network ----------
  function bn(M,x,n,ch){
    var p=n+'/',mu=M.t(p+'moving_mean'),va=M.t(p+'moving_variance'),ga=M.t(p+'gamma'),be=M.t(p+'beta');
    var sc=new Float32Array(ch),sh=new Float32Array(ch);
    for(var c=0;c<ch;c++){sc[c]=ga[c]/Math.sqrt(va[c]+1e-3);sh[c]=be[c]-mu[c]*sc[c];}
    for(var i=0;i<x.length;i++){var c=i%ch;x[i]=x[i]*sc[c]+sh[c];}
    return x;
  }
  function dense(x,T,inN,W,b,outN){
    var out=new Float32Array(T*outN);
    for(var t=0;t<T;t++){
      var xo=t*inN,oo=t*outN;
      for(var o=0;o<outN;o++)out[oo+o]=b[o];
      for(var i=0;i<inN;i++){var v=x[xo+i];if(v===0)continue;var wo=i*outN;for(var o=0;o<outN;o++)out[oo+o]+=v*W[wo+o];}
    }
    return out;
  }
  function hsig(v){v=0.2*v+0.5;return v<0?0:v>1?1:v;}
  function gru(M,x,T,inN,p,rev){
    var W=M.t(p+'kernel'),U=M.t(p+'recurrent_kernel'),b=M.t(p+'bias'),u=128,u3=384;
    var xs=dense(x,T,inN,W,b,u3),h=new Float32Array(u),out=new Float32Array(T*u),hz=new Float32Array(u3),rh=new Float32Array(u);
    for(var s=0;s<T;s++){
      var t=rev?T-1-s:s,xo=t*u3;
      hz.fill(0);
      for(var i=0;i<u;i++){var v=h[i];if(v===0)continue;var wo=i*u3;for(var o=0;o<2*u;o++)hz[o]+=v*U[wo+o];}
      var z=new Float32Array(u);
      for(var o=0;o<u;o++){z[o]=hsig(xs[xo+o]+hz[o]);rh[o]=hsig(xs[xo+u+o]+hz[u+o])*h[o];}
      for(var o=0;o<u;o++){
        var a=xs[xo+2*u+o];for(var i=0;i<u;i++)a+=rh[i]*U[i*u3+2*u+o];
        h[o]=z[o]*h[o]+(1-z[o])*Math.tanh(a);
      }
      out.set(h,t*u);
    }
    return out;
  }
  function bidir(M,x,T,inN,n,k){
    var f=gru(M,x,T,inN,n+'/forward_gru_'+k+'/',false),b=gru(M,x,T,inN,n+'/backward_gru_'+k+'/',true),out=new Float32Array(T*256);
    for(var t=0;t<T;t++){out.set(f.subarray(t*128,t*128+128),t*256);out.set(b.subarray(t*128,t*128+128),t*256+128);}
    return out;
  }
  function softmaxRows(x,T,n){
    for(var t=0;t<T;t++){var o=t*n,m=-Infinity,s=0;for(var i=0;i<n;i++)if(x[o+i]>m)m=x[o+i];for(var i=0;i<n;i++){x[o+i]=Math.exp(x[o+i]-m);s+=x[o+i];}for(var i=0;i<n;i++)x[o+i]/=s;}
    return x;
  }
  async function network(M,h1,h2,T,progress){
    // input (T, 216, 2), channels last
    var x=new Float32Array(T*216*2);
    for(var i=0;i<T*216;i++){x[2*i]=h1[i];x[2*i+1]=h2[i];}
    bn(M,x,'batch_normalization_1',2);
    var K=M.t('conv2d_1/kernel'),kb=M.t('conv2d_1/bias')[0],y=new Float32Array(T*216);
    for(var t=0;t<T;t++)for(var f=0;f<216;f++){
      var s=kb;
      for(var i=0;i<5;i++){var tt=t+i-2;if(tt<0||tt>=T)continue;for(var j=0;j<5;j++){var ff=f+j-2;if(ff<0||ff>=216)continue;var xo=(tt*216+ff)*2,ko=((i*5+j)*2);s+=x[xo]*K[ko]+x[xo+1]*K[ko+1];}}
      y[t*216+f]=s>0?s:0;
    }
    bn(M,y,'batch_normalization_2',1);
    var y2=dense(y,T,216,M.t('conv2d_2/kernel'),M.t('conv2d_2/bias'),72);
    for(var i=0;i<y2.length;i++)if(y2[i]<0)y2[i]=0;
    bn(M,y2,'batch_normalization_3',72);
    progress(0.45);await tick();
    var g1=bidir(M,y2,T,72,'bidirectional_1',1);
    bn(M,g1,'batch_normalization_4',256);
    progress(0.7);await tick();
    var g2=bidir(M,g1,T,256,'bidirectional_2',2);
    progress(0.92);await tick();
    var pitch=dense(g2,T,256,M.t('chord_pitch/kernel'),M.t('chord_pitch/bias'),12);
    for(var i=0;i<pitch.length;i++)pitch[i]=1/(1+Math.exp(-pitch[i]));
    var root=softmaxRows(dense(g2,T,256,M.t('chord_root/kernel'),M.t('chord_root/bias'),13),T,13);
    var bass=softmaxRows(dense(g2,T,256,M.t('chord_bass/kernel'),M.t('chord_bass/bias'),13),T,13);
    var cat=new Float32Array(T*294);
    for(var t=0;t<T;t++){cat.set(g2.subarray(t*256,t*256+256),t*294);cat.set(pitch.subarray(t*12,t*12+12),t*294+256);cat.set(root.subarray(t*13,t*13+13),t*294+268);cat.set(bass.subarray(t*13,t*13+13),t*294+281);}
    bn(M,cat,'batch_normalization_5',294);
    var tag=softmaxRows(dense(cat,T,294,M.t('chord_tag/kernel'),M.t('chord_tag/bias'),170),T,170);
    return {tag:tag,bass:bass};
  }

  // ---------- decoding ----------
  var QUAL={maj:[0,4,7],min:[0,3,7],dim:[0,3,6],aug:[0,4,8],min7:[0,3,7,10],maj7:[0,4,7,11],'7':[0,4,7,10],dim7:[0,3,6,9],
    hdim7:[0,3,6,10],minmaj7:[0,3,7,11],min6:[0,3,7,9],maj6:[0,4,7,9],sus2:[0,2,7],sus4:[0,5,7]};
  var PCS={C:0,'C#':1,D:2,'D#':3,E:4,F:5,'F#':6,G:7,'G#':8,A:9,'A#':10,B:11};
  var BASS_PC=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  function viterbi(tag,T,n,pSelf,pOther){
    var ls=Math.log(pSelf),lo=Math.log(pOther),v=new Float64Array(n),nv=new Float64Array(n),bp=new Int16Array(T*n);
    for(var s=0;s<n;s++)v[s]=Math.log(tag[s]+1e-12);
    for(var t=1;t<T;t++){
      var best=0;for(var s=1;s<n;s++)if(v[s]>v[best])best=s;
      for(var s=0;s<n;s++){
        var stay=v[s]+ls,jump=v[best]+lo,from=s,val=stay;
        if(jump>stay){val=jump;from=best;}
        nv[s]=val+Math.log(tag[t*n+s]+1e-12);bp[t*n+s]=from;
      }
      var tmp=v;v=nv;nv=tmp;
    }
    var path=new Int16Array(T),b=0;for(var s=1;s<n;s++)if(v[s]>v[b])b=s;
    for(var t=T-1;t>=0;t--){path[t]=b;b=bp[t*n+b];}
    return path;
  }
  // [[start, end, "D#:min7/b3"], ...] in seconds; same shape as the server's chord output
  function segments(tag,bass,T,M){
    var path=viterbi(tag,T,M.classes.length,M.p_self,M.p_other),fps=M.sr/M.hop,out=[];
    for(var i=0;i<T;){
      var j=i;while(j+1<T&&path[j+1]===path[i])j++;
      var v=M.classes[path[i]];
      if(v!=='N'&&v!=='X'){
        var lg=new Float64Array(13);
        for(var t=i;t<=Math.min(T-1,j+1);t++)for(var k=0;k<13;k++)lg[k]+=Math.log(bass[t*13+k]+1e-12);
        var bp=0;for(var k=1;k<13;k++)if(lg[k]>lg[bp])bp=k;
        var m=/^([A-G]#?):(.+)$/.exec(v);
        if(m&&bp<12){
          var rel=((bp-PCS[m[1]])%12+12)%12;
          if(rel&&QUAL[m[2]]&&QUAL[m[2]].indexOf(rel)>-1)v+='/'+BASS_PC[bp];
        }
      }
      out.push([i/fps,(j+1)/fps,v]);i=j+1;
    }
    return out;
  }

  async function analyze(buf,progress){
    progress=progress||function(){};
    var M=await load();
    progress(0.02);
    var y=buf.sampleRate===44100&&buf.numberOfChannels===1?buf.getChannelData(0):await CBA.resample(buf,44100);
    var T=1+Math.floor(y.length/M.hop);
    var h1=cqtHarmonic(y,M.cqt[0],M,T);progress(0.15);await tick();
    var h2=cqtHarmonic(y,M.cqt[1],M,T);progress(0.3);await tick();
    var net=await network(M,h1,h2,T,progress);
    var segs=segments(net.tag,net.bass,T,M);
    progress(1);
    return segs;
  }

  return {load:load,analyze:analyze};
})();
