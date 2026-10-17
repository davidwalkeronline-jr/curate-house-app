// =================== CHORD CHART BUILDER: MUSIC THEORY ===================
var CBT=(function(){
  var SHARP=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  var FLAT=['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
  var BASE={C:0,D:2,E:4,F:5,G:7,A:9,B:11};
  var KEYS=['C','Db','D','Eb','E','F','F#','Gb','G','Ab','A','Bb','B','Cm','C#m','Dm','D#m','Ebm','Em','Fm','F#m','Gm','G#m','Am','Bbm','Bm'];
  var CHORD_RE=/^([A-G])([#b]?)([^/\s]*)(?:\/([A-G])([#b]?))?$/;

  function pcOf(letter,acc){
    var p=BASE[letter];
    if(acc==='#')p++;else if(acc==='b')p--;
    return (p+12)%12;
  }
  function parseKey(key){
    var m=/^([A-G])([#b]?)(m?)$/.exec((key||'').trim());
    if(!m)return {pc:7,minor:false};
    return {pc:pcOf(m[1],m[2]),minor:m[3]==='m'};
  }
  // Major keys with flats, plus minor keys whose relative major uses flats.
  function useFlats(key){
    var k=parseKey(key);
    var maj=k.minor?(k.pc+3)%12:k.pc;
    if(key==='F#'||key==='F#m'||key==='D#m'||key==='C#m'||key==='G#m')return false;
    return [5,10,3,8,1,6].indexOf(maj)>-1;
  }
  function spell(pc,key){return (useFlats(key)?FLAT:SHARP)[(pc%12+12)%12];}
  function keyName(pc,minor){
    // Prefer the common worship spellings for each tonic.
    var maj=['C','Db','D','Eb','E','F','F#','G','Ab','A','Bb','B'];
    var min=['Cm','C#m','Dm','Ebm','Em','Fm','F#m','Gm','G#m','Am','Bbm','Bm'];
    return (minor?min:maj)[(pc%12+12)%12];
  }
  function parseChord(str){
    var m=CHORD_RE.exec((str||'').trim());
    if(!m)return null;
    return {root:pcOf(m[1],m[2]),qual:m[3],bass:m[4]?pcOf(m[4],m[5]):null};
  }
  function chordName(c,key){
    return spell(c.root,key)+c.qual+(c.bass!=null?'/'+spell(c.bass,key):'');
  }
  // Nashville degree of a pitch class relative to the key tonic (major scale steps).
  var DEG=['1','b2','2','b3','3','4','#4','5','b6','6','b7','7'];
  function degree(pc,key){
    var k=parseKey(key);
    return DEG[((pc-k.pc)%12+12)%12];
  }
  function toNumber(str,key){
    var c=parseChord(str);
    if(!c)return str;
    var q=c.qual;
    return degree(c.root,key)+q+(c.bass!=null?'/'+degree(c.bass,key):'');
  }
  function transposeChord(str,semis,newKey){
    var c=parseChord(str);
    if(!c)return str;
    c.root=(c.root+semis+120)%12;
    if(c.bass!=null)c.bass=(c.bass+semis+120)%12;
    return chordName(c,newKey);
  }
  function transposeKey(key,semis){
    var k=parseKey(key);
    return keyName((k.pc+semis+120)%12,k.minor);
  }
  function transposeText(text,semis,newKey){
    return text.replace(/\[([^\]]+)\]/g,function(_,ch){return '['+transposeChord(ch,semis,newKey)+']';})
      .split('\n').map(function(line){
        if(line.indexOf('|')<0)return line;
        return line.replace(/[^|\s]+/g,function(tok){return parseChord(tok)?transposeChord(tok,semis,newKey):tok;});
      }).join('\n');
  }
  return {KEYS:KEYS,parseKey:parseKey,spell:spell,keyName:keyName,parseChord:parseChord,chordName:chordName,
    toNumber:toNumber,transposeChord:transposeChord,transposeKey:transposeKey,transposeText:transposeText};
})();
