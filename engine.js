export const W=9,H=10;
export const names={r:{k:'帥',a:'仕',e:'相',h:'馬',c:'車',p:'炮',s:'兵'},b:{k:'將',a:'士',e:'象',h:'馬',c:'車',p:'砲',s:'卒'}};
export const other=s=>s==='r'?'b':'r';
export const at=(x,y)=>y*W+x;
export function neighbors(i){const x=i%9,y=Math.floor(i/9);return [[x-1,y],[x+1,y],[x,y-1],[x,y+1]].filter(([x,y])=>x>=0&&x<9&&y>=0&&y<10).map(([x,y])=>at(x,y));}
export function initial(){const b=Array(90).fill(null);for(const side of ['r','b']){const y=side==='r'?9:0;['c','h','e','a','k','a','e','h','c'].forEach((t,x)=>b[at(x,y)]={s:side,t});for(const x of [1,7])b[at(x,side==='r'?7:2)]={s:side,t:'p'};for(const x of [0,2,4,6,8])b[at(x,side==='r'?6:3)]={s:side,t:'s'};}return b;}
export function group(b,i){if(!b[i])return {cells:[],liberties:[]};const seen=new Set([i]),lib=new Set(),queue=[i];for(const n of queue)for(const j of neighbors(n)){if(!b[j])lib.add(j);else if(b[j].s===b[i].s&&!seen.has(j)){seen.add(j);queue.push(j);}}return {cells:[...seen],liberties:[...lib]};}
export function groups(b,side){const seen=new Set(),out=[];for(let i=0;i<90;i++)if(b[i]?.s===side&&!seen.has(i)){const g=group(b,i);g.cells.forEach(j=>seen.add(j));out.push(g);}return out;}
export function chessLegal(b,from,to){const p=b[from];if(!p||p.t==='g'||from===to||b[to]?.s===p.s)return false;const x=from%9,y=Math.floor(from/9),u=to%9,v=Math.floor(to/9),dx=u-x,dy=v-y,ax=Math.abs(dx),ay=Math.abs(dy);const palace=u>=3&&u<=5&&(p.s==='r'?v>=7:v<=2);const home=p.s==='r'?v>=5:v<=4;let blockers=0;if(dx===0||dy===0){const step=dx===0?Math.sign(dy)*9:Math.sign(dx);for(let i=from+step;i!==to;i+=step)if(b[i])blockers++;}
  switch(p.t){case 'c':return (dx===0||dy===0)&&blockers===0;case 'p':return (dx===0||dy===0)&&blockers===(b[to]?1:0);case 'h':return ax*ay===2&&!b[at(x+(ax===2?Math.sign(dx):0),y+(ay===2?Math.sign(dy):0))];case 'e':return ax===2&&ay===2&&home&&!b[at(x+dx/2,y+dy/2)];case 'a':return ax===1&&ay===1&&palace;case 'k':return (ax+ay===1&&palace)||(dx===0&&b[to]?.t==='k'&&blockers===0);case 's':return (dx===0&&dy===(p.s==='r'?-1:1))||(ay===0&&ax===1&&(p.s==='r'?y<=4:y>=5));}return false;
}
export const key=b=>b.map(p=>p?p.s+p.t:'..').join('');
export function play(b,side,action,history=[]){const {from,to}=action;if(!Number.isInteger(to)||to<0||to>=90)return {error:'请选择棋盘内的交叉点。'};if(from==null){if(b[to])return {error:'围棋只能落在空交叉点。'};}else if(b[from]?.s!==side||!chessLegal(b,from,to))return {error:'这一步不符合象棋走法，或路径被棋子阻挡。'};
  const next=b.slice(),captured=[];if(next[to])captured.push(next[to]);next[to]=from==null?{s:side,t:'g'}:next[from];if(from!=null)next[from]=null;
  for(const g of groups(next,other(side)))if(!g.liberties.length)for(const i of g.cells){captured.push(next[i]);next[i]=null;}
  // A captured leader ends the game immediately, before suicide validation.
  const winner=next.some(p=>p?.s===other(side)&&p.t==='k')?null:side;
  if(!winner&&groups(next,side).some(g=>!g.liberties.length))return {error:'禁自杀：这一步会使己方棋块没有气。'};
  if(history.includes(key(next)))return {error:'禁全局同形：不能重复本局已出现的棋盘局面。'};
  return {board:next,captured,winner};
}
export function actions(b,s,history=[]){const out=[];for(let to=0;to<90;to++){if(!b[to]){const a={from:null,to},r=play(b,s,a,history);if(!r.error)out.push({a,r});}for(let from=0;from<90;from++)if(b[from]?.s===s&&chessLegal(b,from,to)){const a={from,to},r=play(b,s,a,history);if(!r.error)out.push({a,r});}}return out;}
const value={k:100000,c:950,p:500,h:450,e:220,a:220,s:140,g:0};
// Exact one-ply king threats: direct captures and filling the king block's last liberty.
// Validation goes through play(), so suicide, capture order and superko all apply.
export function winningActions(b,s,history=[]){
  const king=b.findIndex(p=>p?.s===other(s)&&p.t==='k');
  if(king<0)return [];
  const targets=[king],g=group(b,king),out=[];
  if(g.liberties.length===1)targets.push(g.liberties[0]);
  for(const to of targets){
    const candidates=[];
    if(!b[to])candidates.push({from:null,to});
    for(let from=0;from<90;from++)if(b[from]?.s===s&&chessLegal(b,from,to))candidates.push({from,to});
    for(const a of candidates){const r=play(b,s,a,history);if(r.winner===s)out.push(a);}
  }
  return out;
}
export function danger(b,side,history=[]){return winningActions(b,other(side),history).length>0;}
export function evaluate(b,s){
  let score=0;
  for(const side of [s,other(s)]){
    const sign=side===s?1:-1;
    for(let i=0;i<90;i++){
      const p=b[i];if(p?.s!==side)continue;
      const y=Math.floor(i/9),x=i%9,advance=side==='r'?9-y:y;
      let v=value[p.t];
      if(p.t==='s')v+=advance*12+(advance>=5?45:0);
      if(['h','c','p'].includes(p.t)){
        v+=advance*4+(4-Math.abs(x-4))*5;
        let mobility=0;for(let to=0;to<90;to++)if(chessLegal(b,i,to))mobility++;
        v+=Math.min(mobility,20)*3;
      }
      // Stones have no free material reward; only their tactical shape matters.
      if(p.t!=='g'&&p.t!=='k'){
        let attacker=Infinity;
        for(let j=0;j<90;j++)if(b[j]?.s===other(side)&&chessLegal(b,j,i))attacker=Math.min(attacker,value[b[j].t]);
        if(attacker<Infinity)v-=Math.max(30,(value[p.t]-attacker*.55)*.42);
      }
      score+=sign*v;
    }
    for(const g of groups(b,side)){
      const worth=g.cells.reduce((v,i)=>v+value[b[i].t],0),libs=g.liberties.length;
      score+=sign*(Math.min(libs,5)*2-(libs===1?Math.min(worth*.7,18000):libs===2?Math.min(worth*.18,2500):0));
    }
  }
  return score;
}
export function choose(b,s,history=[],level='normal',options={}){
  const settings={easy:{ms:650,depth:2,width:8},normal:{ms:2200,depth:4,width:12},hard:{ms:5000,depth:5,width:18}}[level]||{ms:2200,depth:4,width:12};
  const start=performance.now(),deadline=start+(options.timeMs??settings.ms),MATE=1e8;
  const winning=winningActions(b,s,history);if(winning.length)return winning[0];
  const roots=actions(b,s,history);if(!roots.length)return null;
  // Scan EVERY legal root for immediate defeat before applying any beam pruning.
  for(const m of roots){m.unsafe=danger(m.r.board,s,[...history,key(m.r.board)]);m.score=evaluate(m.r.board,s);}
  const safe=roots.filter(m=>!m.unsafe),pool=safe.length?safe:roots;
  pool.sort((a,b)=>b.score-a.score);let best=pool[0].a,completedDepth=1,nodes=0;
  const timeout={};
  function search(board,turn,h,depth,alpha,beta,ply){
    if(performance.now()>deadline)throw timeout;nodes++;
    if(winningActions(board,turn,h).length)return MATE-ply;
    if(depth<=0)return evaluate(board,turn);
    const moves=actions(board,turn,h);if(!moves.length)return -MATE+ply;
    const threatened=danger(board,turn,h);
    let candidates=moves;
    if(threatened){candidates=moves.filter(m=>!danger(m.r.board,turn,[...h,key(m.r.board)]));if(!candidates.length)return -MATE+ply+1;}
    for(const m of candidates){if(performance.now()>deadline)throw timeout;m.score=evaluate(m.r.board,turn);}
    candidates.sort((a,b)=>b.score-a.score);
    let result=-Infinity;
    for(const m of candidates.slice(0,settings.width)){
      const v=-search(m.r.board,other(turn),[...h,key(m.r.board)],depth-1,-beta,-alpha,ply+1);
      result=Math.max(result,v);alpha=Math.max(alpha,v);if(alpha>=beta)break;
    }
    return result;
  }
  for(let depth=2;depth<=settings.depth;depth++){
    let iterationBest=best,highest=-Infinity;const ranked=[];
    try{
      for(const m of pool.slice(0,settings.width)){
        const score=-search(m.r.board,other(s),[...history,key(m.r.board)],depth-1,-Infinity,-highest,1);
        ranked.push({m,score});if(score>highest){highest=score;iterationBest=m.a;}
      }
    }catch(e){if(e!==timeout)throw e;break;}
    best=iterationBest;completedDepth=depth;
    ranked.sort((a,b)=>b.score-a.score);pool.splice(0,ranked.length,...ranked.map(x=>x.m));
    if(highest>MATE-100)break;
  }
  options.onStats?.({depth:completedDepth,nodes,ms:Math.round(performance.now()-start),safeMoves:safe.length});
  return best;
}
