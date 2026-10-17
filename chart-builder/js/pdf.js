// =================== PDF CHART (layout modeled on the MultiTracks numbers chart) ===================
// Header with key/tempo/time, a roadmap of colored section badges, then each section in a
// rounded box with its badge and title set into the top border and band dynamics on the right.
var CBP=(function(){
  var W=612,H=792,M=55,GUT=22,PAD=14;
  var SCALE={S:0.9,M:1,L:1.12};
  var INK=[20,20,20],DARK=[85,85,85],MID=[140,140,140],RULE=[160,160,160];
  var COLORS={I:[38,110,126],V:[83,72,150],PC:[176,122,30],C:[160,64,32],Po:[160,96,32],B:[128,44,60],In:[138,46,46],It:[138,46,46],
    Ta:[79,122,40],T:[110,96,40],Vp:[90,90,90],Rf:[44,112,92],O:[38,110,126],E:[38,110,126]};
  var FONT_FILES={normal:'fonts/OpenSans-Regular.ttf',bold:'fonts/OpenSans-Bold.ttf',semibold:'fonts/OpenSans-SemiBold.ttf'};
  var fontData=null;

  // Open Sans is loaded once from the app folder; if that fails the chart falls back to Helvetica.
  function loadFonts(){
    if(fontData)return fontData;
    fontData=Promise.all(Object.keys(FONT_FILES).map(function(k){
      return fetch(FONT_FILES[k]).then(function(r){if(!r.ok)throw new Error(r.status);return r.arrayBuffer();}).then(function(buf){
        var bytes=new Uint8Array(buf),bin='';
        for(var i=0;i<bytes.length;i+=0x8000)bin+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));
        return [k,btoa(bin)];
      });
    })).then(function(list){var o={};list.forEach(function(x){o[x[0]]=x[1];});return o;}).catch(function(e){
      console.warn('Open Sans unavailable, using Helvetica',e);return null;
    });
    return fontData;
  }

  function colorFor(ab){
    var m=/^[A-Za-z]+/.exec(ab||''),k=m?m[0]:'';
    return COLORS[k]||COLORS[k.charAt(0)]||[110,110,110];
  }
  function parsePieces(line){
    var re=/\[([^\]]*)\]/g,pieces=[],last=0,m,pend=null;
    while((m=re.exec(line))){
      var txt=line.slice(last,m.index);
      if(txt||pend!==null)pieces.push({chord:pend,text:txt});
      pend=m[1];last=re.lastIndex;
    }
    pieces.push({chord:pend,text:line.slice(last)});
    return pieces.filter(function(p){return p.chord!==null||p.text;});
  }
  function toUnits(pieces){
    var units=[],cur=[];
    pieces.forEach(function(p){
      var parts=p.text.split(/(\s+)/),chord=p.chord;
      parts.forEach(function(part,i){
        if(part&&/^\s+$/.test(part)){
          if(!cur.length){cur.push({chord:chord,text:''});chord=null;}
          cur[cur.length-1].text+=' ';units.push(cur);cur=[];
        } else if(part||(i===0&&chord!=null)){cur.push({chord:chord,text:part});chord=null;}
      });
    });
    if(cur.length)units.push(cur);
    return units;
  }
  // "4sus2" -> base "4", superscript "sus2"; "6m7/3" -> "6m", "7", "/3"
  var SPLIT=/^([A-G][#b]?|[#b]?[1-7])(m(?!aj))?([^/]*)(\/.+)?$/;

  function render(chart,fonts){
    var J=window.jspdf&&window.jspdf.jsPDF;
    if(!J)throw new Error('The PDF library has not loaded yet. Check your connection and try again.');
    var doc=new J({unit:'pt',format:'letter'});
    var FAM='helvetica',SEMI='bold';
    if(fonts){
      doc.addFileToVFS('OpenSans-Regular.ttf',fonts.normal);doc.addFont('OpenSans-Regular.ttf','OpenSans','normal');
      doc.addFileToVFS('OpenSans-Bold.ttf',fonts.bold);doc.addFont('OpenSans-Bold.ttf','OpenSans','bold');
      doc.addFileToVFS('OpenSans-SemiBold.ttf',fonts.semibold);doc.addFont('OpenSans-SemiBold.ttf','OpenSans','semibold');
      FAM='OpenSans';SEMI='semibold';
    }
    var k=SCALE[chart.size]||1,cols=+chart.columns===1?1:2;
    var colW=cols===1?W-2*M:(W-2*M-GUT)/2,inner=colW-2*PAD;
    var F={lyric:10*k,chord:10*k,sup:6.8*k,num:7*k,note:8.8*k,title:10.5*k};
    var R={chord:F.chord*1.22,lyric:F.lyric*1.55,bars:F.chord*1.9,cue:F.note*1.7,note:F.note*1.45,space:6*k};
    var key=chart.key||'C';

    function clean(s){
      s=String(s==null?'':s);
      if(fonts)return s.replace(/[\u0000-\u0008\u000B-\u001F]/g,'');
      return s.replace(/[‘’ʼ]/g,"'").replace(/[“”]/g,'"').replace(/…/g,'...')
        .replace(/[–—]/g,'-').replace(/[^\x00-\xFF]/g,'');
    }
    function font(style,size,color){
      if(style==='mark')doc.setFont('times','bolditalic');
      else doc.setFont(FAM,style==='semibold'?SEMI:style);
      doc.setFontSize(size);doc.setTextColor.apply(doc,color||INK);
      if(doc.setCharSpace)doc.setCharSpace(0);
    }
    // measure without kerning: jsPDF draws standard fonts unkerned
    function tw(str,style,size){font(style,size);return doc.getStringUnitWidth(str,{kerning:{}})*size;}

    // ---------- chords ----------
    function chordRuns(ch,size,color){
      ch=clean(ch).trim();size=size||F.chord;color=color||INK;
      var valid=!!CBT.parseChord(ch),shown=ch,runs=[];
      if(valid&&chart.notation==='numbers')shown=CBT.toNumber(ch,key);
      var m=SPLIT.exec(shown);
      if(!m)runs.push({t:shown,s:'bold',z:size,c:color,up:0});
      else{
        runs.push({t:m[1]+(m[2]||''),s:'bold',z:size,c:color,up:0});
        if(m[3])runs.push({t:m[3],s:'bold',z:size*0.68,c:color,up:size*0.38});
        if(m[4])runs.push({t:m[4],s:'bold',z:size,c:color,up:0});
      }
      if(valid&&chart.notation==='both')runs.push({t:' '+CBT.toNumber(ch,key),s:'normal',z:F.num,c:MID,up:0});
      return runs;
    }
    function runsW(runs){return runs.reduce(function(a,r){return a+tw(r.t,r.s,r.z);},0);}
    function drawRuns(runs,x,y){runs.forEach(function(r){font(r.s,r.z,r.c);doc.text(r.t,x,y-r.up);x+=tw(r.t,r.s,r.z);});}

    // ---------- content rows (x is the box's inner left edge) ----------
    // chord tokens in rows; a row only breaks between bars so a bar's chords stay together
    function chordLine(tokens){
      var rows=[],cur=[],cx=0,gap=11*k,bars=[];
      tokens.forEach(function(t,i){
        var runs=t.bar?[{t:t.text,s:'bold',z:F.chord,c:MID,up:0}]:chordRuns(t.text);
        if(i===0||t.newBar)bars.push([]);
        bars[bars.length-1].push({runs:runs,w:runsW(runs)});
      });
      bars.forEach(function(bar){
        var bw=bar.reduce(function(a,e,i){return a+(i?gap:0)+e.w;},0),g=cur.length?gap*1.35:0;
        if(cur.length&&cx+g+bw>inner){rows.push(cur);cur=[];cx=0;g=0;}
        cx+=g;
        bar.forEach(function(e,i){if(i)cx+=gap;cur.push({x:cx,runs:e.runs});cx+=e.w;});
      });
      if(cur.length)rows.push(cur);
      return rows.map(function(r){return {h:R.bars,draw:function(x,y){r.forEach(function(e){drawRuns(e.runs,x+e.x,y+R.bars*0.66);});}};});
    }
    function lyricRows(line){
      var units=toUnits(parsePieces(line));
      var anyText=units.some(function(u){return u.some(function(p){return p.text.trim();});});
      if(!anyText){
        var toks=[];units.forEach(function(u){u.forEach(function(p){if(p.chord)toks.push({text:p.chord});});});
        return chordLine(toks);
      }
      var gap=5*k;
      function layoutUnit(u){
        var x=0,end=0,items=[];
        u.forEach(function(p){
          var t=clean(p.text),txW=tw(t,'normal',F.lyric),runs=p.chord!=null?chordRuns(p.chord):null,cw=runs?runsW(runs):0;
          items.push({x:x,t:t,runs:runs});
          end=Math.max(end,x+txW,x+cw);
          x+=Math.max(txW,runs?cw+gap:0);
        });
        return {w:x,end:end,items:items,chord:u.some(function(p){return p.chord!=null;})};
      }
      var lines=[],cur=[],cx=0;
      units.map(layoutUnit).forEach(function(lu){
        if(cur.length&&cx+lu.end>inner){lines.push(cur);cur=[];cx=0;}
        cur.push({off:cx,lu:lu});cx+=lu.w;
      });
      if(cur.length)lines.push(cur);
      return lines.map(function(ln,li){
        var hasC=ln.some(function(e){return e.lu.chord;}),indent=li?10*k:0;
        return {h:(hasC?R.chord:0)+R.lyric,draw:function(x,y){
          var cy=y+F.chord,ly=y+(hasC?R.chord:0)+F.lyric;
          ln.forEach(function(e){e.lu.items.forEach(function(it){
            var px=x+indent+e.off+it.x;
            if(it.runs&&hasC)drawRuns(it.runs,px,cy);
            if(it.t){font('normal',F.lyric);doc.text(it.t,px,ly);}
          });});
        }};
      });
    }
    function barRows(line){
      var cells=line.split('|').map(function(c){return c.trim();}).filter(Boolean),toks=[];
      cells.forEach(function(cell){
        cell.split(/\s+/).filter(Boolean).forEach(function(t,i){
          toks.push({text:t,bar:t==='%'||/^n\.?c\.?$/i.test(t),newBar:i===0});
        });
      });
      return chordLine(toks);
    }
    function cueRow(text){
      text=clean(text);
      return {h:R.cue,draw:function(x,y){font('normal',F.note,MID);doc.text(doc.splitTextToSize(text,inner)[0]||'',x,y+R.cue*0.68);}};
    }
    function contentRows(text){
      var rows=[],blank=false;
      (text||'').replace(/\r/g,'').split('\n').forEach(function(raw){
        var line=raw.replace(/\s+$/,'');
        if(!line.trim()){if(rows.length&&!blank)rows.push({h:R.space,space:true,draw:function(){}});blank=true;return;}
        blank=false;
        var t=line.trim();
        if(/^\(.*\)$/.test(t))rows.push(cueRow(t.slice(1,-1)));
        else if(t.indexOf('|')>-1&&t.indexOf('[')<0)rows=rows.concat(barRows(t));
        else rows=rows.concat(lyricRows(line));
      });
      while(rows.length&&rows[rows.length-1].space)rows.pop();
      return rows;
    }
    // band dynamics: right aligned in the top of the box, mark (mf) first
    function noteRows(sec){
      var note=clean(sec.cue||''),mark=clean(sec.mark||''),rows=[];
      if(!note&&!mark)return rows;
      var mw=mark?tw(mark,'mark',F.note*1.25)+5*k:0;
      font('normal',F.note);
      var lines=note?doc.splitTextToSize(note,inner*0.8):[''];
      lines.forEach(function(l,i){
        rows.push({h:R.note,draw:function(x,y){
          var base=y+R.note*0.72,lw=l?tw(l,'normal',F.note):0,right=x+inner;
          if(l){font('normal',F.note,MID);doc.text(l,right-lw,base);}
          if(i===0&&mark){font('mark',F.note*1.25,DARK);doc.text(mark,right-lw-mw+(l?0:5*k),base);}
        }});
      });
      return rows;
    }

    // ---------- blocks ----------
    var seen={},blocks=[];
    (chart.sections||[]).forEach(function(sec){
      var sig=(sec.name||'').trim().toLowerCase()+'\n'+(sec.text||'').trim();
      var body=chart.condense&&seen[sig]&&(sec.text||'').trim()?[cueRow('Same as above')]:contentRows(sec.text);
      seen[sig]=1;
      var rows=[{h:13*k,pad:true,draw:function(){}}].concat(noteRows(sec));
      if(rows.length>1)rows.push({h:3*k,draw:function(){}});
      rows=rows.concat(body);
      rows.push({h:9*k,pad:true,draw:function(){}});
      blocks.push({sec:sec,rows:rows,keep:Math.min(rows.length,4)});
    });

    // ---------- page chrome ----------
    var FIRST_TOP=0,CONT_TOP=96,BOTTOM=H-62;
    function roadmapLayout(){
      var toks=(chart.roadmap||'').trim().split(/\s+/).filter(Boolean),items=[];
      toks.forEach(function(t){
        var m=/^x(\d+)$/i.exec(t);
        if(m&&items.length)items[items.length-1].rep=+m[1];
        else items.push({ab:clean(t),rep:1});
      });
      var d=16,stepX=24,x=M+PAD+d/2,rows=[[]];
      items.forEach(function(it){
        var w=Math.max(d,tw(it.ab,'semibold',6.4)+7);
        it.w=w;
        if(x+w/2>W-M){rows.push([]);x=M+PAD+d/2;}
        it.x=x;rows[rows.length-1].push(it);x+=Math.max(stepX,w+8);
      });
      return {rows:rows,h:items.length?rows.length*24:0};
    }
    var road=roadmapLayout();
    FIRST_TOP=104+road.h+16;
    function badge(ab,cx,cy,rep){
      var col=colorFor(ab),w=Math.max(16,tw(ab,'semibold',6.4)+7);
      doc.setDrawColor.apply(doc,col);doc.setFillColor(255,255,255);doc.setLineWidth(1.1);
      if(w>16.5)doc.roundedRect(cx-w/2,cy-8,w,16,8,8,'FD');else doc.circle(cx,cy,8,'FD');
      font('semibold',6.4,[40,40,40]);doc.text(ab,cx,cy+2.3,{align:'center'});
      if(rep>1){font('bold',6.5,[40,40,40]);doc.text(String(rep),cx+w/2-1,cy-6.5);}
      return w;
    }
    function infoLine(pairs,y,labelColor,valColor,size){
      var x=W-M-PAD;
      for(var i=pairs.length-1;i>=0;i--){
        var v=clean(pairs[i][1]),l=pairs[i][0]+': ';
        x-=tw(v,'normal',size);font('normal',size,valColor);doc.text(v,x,y);
        x-=tw(l,'bold',size);font('bold',size,labelColor);doc.text(l,x,y);
        x-=12;
      }
    }
    function drawHeader(page,pages){
      var x=M+PAD;
      if(page===0){
        var title=clean(chart.title||'Untitled'),ts=19,maxW=W-2*M-190;
        while(ts>12&&tw(title,'bold',ts)>maxW)ts-=0.5;
        font('bold',ts);doc.text(title,x,70);
        if(chart.artist){font('normal',8,MID);doc.text(clean(chart.artist),x,84);}
        infoLine([['Page',(page+1)+'/'+pages]],70,MID,MID,7.5);
        infoLine([['Key',chart.key||''],['Tempo',chart.tempo||''],['Time',chart.time||'']],84,DARK,MID,7.5);
        road.rows.forEach(function(r,ri){r.forEach(function(it){badge(it.ab,it.x,113+ri*24,it.rep);});});
      } else {
        font('bold',11);doc.text(clean(chart.title||'Untitled'),x,63);
        infoLine([['Page',(page+1)+'/'+pages]],63,MID,MID,7.5);
      }
    }
    function drawFooter(){
      var y=H-46;
      font('bold',7,INK);doc.text('CURATE HOUSE',M+4,y+8,{charSpace:2.2});
      var lx=M+4+tw('CURATE HOUSE','bold',7)+2.2*12+10;
      font('normal',6.5,MID);doc.text('Chord Chart Builder',lx,y+8);
      if(chart.notes){
        font('normal',6.5,MID);
        var lines=doc.splitTextToSize(clean(chart.notes),250).slice(0,3);
        lines.forEach(function(l,i){doc.text(l,W-M,y+8-(lines.length-1-i)*8.5,{align:'right'});});
      }
    }

    // ---------- section box ----------
    function boxFrame(f){
      var x0=f.x,x1=f.x+colW,y0=f.y0,y1=f.y1,r=7,c=r*0.5523;
      doc.setDrawColor.apply(doc,RULE);doc.setLineWidth(0.7);
      var top=f.first?y0+r:y0,bot=f.last?y1-r:y1;
      doc.line(x0,top,x0,bot);doc.line(x1,top,x1,bot);
      if(f.last){
        doc.lines([[0,c,r-c,r,r,r]],x0,y1-r);doc.line(x0+r,y1,x1-r,y1);doc.lines([[c,0,r,c-r,r,-r]],x1-r,y1);
      }
      if(f.first){
        var sec=f.sec,ab=clean(CBB.abbr(sec.name)),title=clean(sec.name||'Section').toUpperCase();
        var bw=Math.max(16,tw(ab,'semibold',6.4)+7),bx=x0+PAD+bw/2;
        var tx=bx+bw/2+6,tW=tw(title,'bold',F.title)+title.length*0.7*k;
        var rep=sec.repeat>1?'x'+sec.repeat:'',rW=rep?tw(rep,'bold',F.title*0.85)+5:0;
        doc.lines([[0,-c,r-c,-r,r,-r]],x0,y0+r);
        doc.line(x0+r,y0,bx-bw/2-4,y0);
        doc.line(tx+tW+rW+7,y0,x1-r,y0);
        doc.lines([[c,0,r,r-c,r,r]],x1-r,y0);
        badge(ab,bx,y0);
        font('bold',F.title);doc.text(title,tx,y0+F.title*0.36,{charSpace:0.7*k});
        if(rep){font('bold',F.title*0.85,MID);doc.text(rep,tx+tW+4,y0+F.title*0.36);}
      }
    }

    // ---------- flow ----------
    function plan(limit){
      var items=[],frames=[],page=0,col=0,top=FIRST_TOP,y=top,frame=null;
      function lim(){return page?BOTTOM:limit;}
      function closeFrame(last){if(frame){frame.y1=y;frame.last=last;frames.push(frame);frame=null;}}
      function nextCol(){col++;if(col>=cols){page++;col=0;top=CONT_TOP;}y=top;}
      blocks.forEach(function(b){
        var h=b.rows.reduce(function(a,r){return a+r.h;},0);
        var keepH=b.rows.slice(0,b.keep).reduce(function(a,r){return a+r.h;},0);
        if(y+h>lim()&&(h<=lim()-top||y+keepH>lim())&&y>top)nextCol();
        frame={sec:b.sec,page:page,col:col,y0:y,first:true};
        b.rows.forEach(function(r,i){
          if(y+r.h>lim()&&y>top&&!r.pad){
            closeFrame(false);nextCol();y+=6;
            frame={sec:b.sec,page:page,col:col,y0:y-6,first:false};
          }
          items.push({page:page,col:col,y:y,row:r});y+=r.h;
        });
        closeFrame(true);
        y+=14*k;
      });
      return {items:items,frames:frames,pages:page+1};
    }
    var layout=plan(BOTTOM);
    if(cols===2&&layout.pages===1){
      var lo=FIRST_TOP,hi=BOTTOM;
      for(var it=0;it<24;it++){var mid=(lo+hi)/2;if(plan(mid).pages===1)hi=mid;else lo=mid;}
      layout=plan(hi+1);
    }
    for(var p=0;p<layout.pages;p++){
      if(p)doc.addPage();
      drawHeader(p,layout.pages);
      layout.frames.forEach(function(f){if(f.page===p){f.x=M+f.col*(colW+GUT);boxFrame(f);}});
      layout.items.forEach(function(e){if(e.page===p)e.row.draw(M+e.col*(colW+GUT)+PAD,e.y);});
      if(p===layout.pages-1)drawFooter();
    }
    return doc;
  }
  return {render:render,loadFonts:loadFonts};
})();
