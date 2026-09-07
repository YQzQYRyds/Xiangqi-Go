import {choose} from './engine.js';
self.onmessage=({data})=>{try{let stats;const action=choose(data.board,data.side,data.history,data.level,{onStats:s=>stats=s});self.postMessage({id:data.id,action,stats});}catch(e){self.postMessage({id:data.id,error:e.message});}};
