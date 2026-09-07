import test from 'node:test';
import assert from 'node:assert/strict';
import {initial,at,group,chessLegal,play,key,choose,danger,winningActions} from './engine.js';
const p=(s,t='g')=>({s,t});
const empty=()=>{const b=Array(90).fill(null);b[at(4,9)]=p('r','k');b[at(4,0)]=p('b','k');return b;};
test('initial arrangement contains 32 chessmen and correct leaders',()=>{const b=initial();assert.equal(b.filter(Boolean).length,32);assert.deepEqual(b[4],p('b','k'));assert.deepEqual(b[85],p('r','k'));});
test('mixed friendly groups share unique liberties, including across river',()=>{const b=empty();b[at(2,4)]=p('r','c');b[at(2,5)]=p('r');const g=group(b,at(2,4));assert.equal(g.cells.length,2);assert.equal(g.liberties.length,6);});
test('Go stone blocks horse leg and elephant eye',()=>{const b=empty();b[at(1,9)]=p('r','h');assert.ok(chessLegal(b,at(1,9),at(2,7)));b[at(1,8)]=p('b');assert.ok(!chessLegal(b,at(1,9),at(2,7)));b[at(2,9)]=p('r','e');b[at(3,8)]=p('r');assert.ok(!chessLegal(b,at(2,9),at(4,7)));});
test('Go stone is a cannon screen and a capturable target',()=>{const b=empty();b[at(0,5)]=p('r','p');b[at(0,3)]=p('r');b[at(0,1)]=p('b');assert.ok(chessLegal(b,at(0,5),at(0,1)));assert.ok(!chessLegal(b,at(0,5),at(0,2)));b[at(0,4)]=p('b');assert.ok(!chessLegal(b,at(0,5),at(0,1)));});
test('stone placement captures entire mixed opposing block',()=>{const b=empty();b[at(0,4)]=p('b','c');b[at(0,5)]=p('b');for(const [x,y] of [[0,3],[1,4],[1,5]])b[at(x,y)]=p('r');const r=play(b,'r',{to:at(0,6)});assert.ok(!r.error);assert.equal(r.captured.length,2);assert.equal(r.board[at(0,4)],null);});
test('suicide forbidden unless capture creates liberty',()=>{const b=empty();b[1]=p('b');b[9]=p('b');assert.match(play(b,'r',{to:0}).error,/自杀/);b[2]=p('r');b[10]=p('r');b[18]=p('r');const r=play(b,'r',{to:0});assert.ok(!r.error);assert.equal(r.captured.length,2);});
test('moving chess can capture by removing last liberty',()=>{const b=empty();b[at(0,4)]=p('b');b[at(0,3)]=p('r');b[at(1,4)]=p('r');b[at(3,5)]=p('r','c');const r=play(b,'r',{from:at(3,5),to:at(0,5)});assert.ok(!r.error);assert.equal(r.captured.length,1);});
test('capture leader directly, via flying general, or by encirclement',()=>{let b=empty();assert.equal(play(b,'r',{from:85,to:4}).winner,'r');b=empty();b[at(3,0)]=p('r');b[at(5,0)]=p('r');assert.equal(play(b,'r',{to:at(4,1)}).winner,'r');});
test('palace, river and pawn direction restrictions',()=>{const b=empty();assert.ok(!chessLegal(b,85,84-1));b[at(2,5)]=p('r','e');assert.ok(!chessLegal(b,at(2,5),at(4,3)));b[at(0,6)]=p('r','s');assert.ok(!chessLegal(b,54,55));assert.ok(chessLegal(b,54,45));b[at(0,4)]=p('r','s');assert.ok(chessLegal(b,36,37));assert.ok(!chessLegal(b,36,45));});
test('positional superko rejects board repetition',()=>{const b=initial(),a={to:40};const r=play(b,'r',a);assert.ok(!r.error);assert.match(play(b,'r',a,[key(r.board)]).error,/同形/);});
test('AI returns a legal action and takes immediate leader capture',()=>{const b=initial(),a=choose(b,'b',[key(b)],'normal');assert.ok(a);assert.ok(!play(b,'b',a,[key(b)]).error);const q=empty();const win=choose(q,'b',[key(q)],'hard');assert.equal(play(q,'b',win).winner,'b');});
test('AI defends king instead of taking unrelated material, at every difficulty',()=>{
  const b=empty();b[at(4,5)]=p('r','c');b[at(0,5)]=p('b','c');b[at(0,6)]=p('r','c');
  assert.ok(danger(b,'b',[key(b)]));
  for(const level of ['easy','normal','hard']){const a=choose(b,'b',[key(b)],level,{timeMs:200});const r=play(b,'b',a,[key(b)]);assert.ok(!r.error);assert.ok(r.winner||!danger(r.board,'b',[key(b),key(r.board)]),level);}
});
test('AI fills last liberty to capture a mixed king block',()=>{
  const b=empty();b[at(3,0)]=p('b');b[at(2,0)]=p('r');b[at(3,1)]=p('r');b[at(5,0)]=p('r');
  b[at(4,5)]=p('b','s');const a=choose(b,'r',[key(b)],'normal',{timeMs:100});assert.equal(a.to,at(4,1));assert.equal(play(b,'r',a,[key(b)]).winner,'r');
});
test('AI rescues king block from surrounding stones',()=>{
  const b=empty();b[at(3,0)]=p('r');b[at(5,0)]=p('r');b[at(4,5)]=p('b','s');
  assert.ok(danger(b,'b'));const a=choose(b,'b',[key(b)],'normal',{timeMs:200});const r=play(b,'b',a,[key(b)]);assert.ok(!r.error);assert.ok(r.winner||!danger(r.board,'b',[key(b),key(r.board)]));
});
test('check detection respects cannon screens and superko',()=>{
  const b=empty();b[at(4,5)]=p('r','p');b[at(4,3)]=p('b');assert.ok(danger(b,'b'));
  const wins=winningActions(b,'r'),states=wins.map(a=>key(play(b,'r',a).board));assert.equal(danger(b,'b',states),false);
  b[at(4,2)]=p('r');assert.equal(danger(b,'b'),false);
});
test('both sides can use friendly or enemy chessmen and Go stones as cannon screens',()=>{
  for(const side of ['r','b'])for(const screenSide of ['r','b'])for(const t of ['g','s','p','h','c','e','a']){
    const b=empty(),enemy=side==='r'?'b':'r',from=at(4,5),to=at(4,side==='r'?0:9);
    b[from]=p(side,'p');b[at(4,side==='r'?3:7)]=p(screenSide,t);
    assert.ok(chessLegal(b,from,to),`${side} over ${screenSide} ${t}`);
    const r=play(b,side,{from,to},[key(b)]);assert.ok(!r.error);assert.equal(r.winner,side);assert.ok(r.captured.some(p=>p.s===enemy&&p.t==='k'));
  }
});
test('cannon cannot capture a leader without a screen or through two screens',()=>{
  const b=empty(),from=at(4,5);b[from]=p('r','p');assert.ok(!chessLegal(b,from,4));
  b[at(4,2)]=p('b');b[at(4,3)]=p('r','s');assert.ok(!chessLegal(b,from,4));
});
test('cannon capture of leader wins even when the destination has no liberties',()=>{
  for(const side of ['r','b']){
    const enemy=side==='r'?'b':'r',y=side==='r'?0:9,b=empty(),from=at(4,5),to=at(4,y);
    b[from]=p(side,'p');b[at(3,y)]=p(enemy,'a');b[at(5,y)]=p(enemy,'a');b[at(4,y===0?1:8)]=p(enemy);
    const r=play(b,side,{from,to},[key(b)]);assert.ok(!r.error);assert.equal(r.winner,side);assert.equal(group(r.board,to).liberties.length,0);
    assert.ok(danger(b,enemy,[key(b)]));assert.ok(winningActions(b,side,[key(b)]).some(a=>a.from===from&&a.to===to));
    assert.equal(play(b,side,choose(b,side,[key(b)],'easy'),[key(b)]).winner,side);
    b[to]=p(enemy,'c');b[at(3,y===0?1:8)]=p(enemy,'k');
    assert.match(play(b,side,{from,to},[key(b)]).error,/自杀/,'ordinary captures still obey suicide rules');
  }
});
test('reported move E6 to E10 wins over enemy stone at E9 in the supplied position',()=>{
  const rows=[
    'bc bh be ba bk ba be bh ..',
    'bg .. .. .. bg rg .. .. ..',
    '.. .. bg .. .. .. .. bc ..',
    'bs bg .. rg .. rg bs .. bs',
    '.. .. .. bg rp .. .. .. ..',
    'bg .. .. rg .. rg .. .. ..',
    '.. bg rg .. rs .. rs .. rs',
    'bg .. bg rg .. .. .. .. ..',
    '.. .. .. .. .. .. .. .. ..',
    '.. .. re ra rk ra re rh ..'
  ];
  const b=rows.flatMap(row=>row.split(' ').map(code=>code==='..'?null:p(code[0],code[1])));
  const from=at(4,4),to=at(4,0),h=[key(b)];
  assert.ok(chessLegal(b,from,to));
  const result=play(b,'r',{from,to},h);
  assert.ok(!result.error);assert.equal(result.winner,'r');
  assert.equal(result.board[to].t,'p');assert.equal(result.board[from],null);
  assert.equal(group(result.board,to).liberties.length,0);
  assert.ok(winningActions(b,'r',h).some(a=>a.from===from&&a.to===to));
});
