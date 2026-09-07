import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Lobby,LobbyError} from './lobby.js';
const root=path.dirname(fileURLToPath(import.meta.url));
const publicFiles=new Set(['index.html','style.css','app.js','engine.js','ai.js','audio.js','online.js']);
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'};
export function createGameServer({lobby=new Lobby()}={}){
  const limits=new Map();
  function limit(id,max){const now=Date.now(),entry=limits.get(id);if(!entry||entry.until<now){limits.set(id,{until:now+60000,count:1});return;}if(++entry.count>max)throw new LobbyError('操作太频繁，请稍后再试。',429);}
  const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  function send(s,res){if(res.destroyed||res.writableEnded)return;if(res.writableLength>1024*1024){res.destroy();return;}res.write(`data: ${JSON.stringify(lobby.snapshot(s))}\n\n`);}
  lobby.onChange=()=>{for(const s of lobby.sessions.values())for(const res of s.streams)send(s,res);};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
    try{
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/health'){json(res,200,{ok:true,rooms:lobby.rooms.size});return;}
      if(url.pathname.startsWith('/api/')){
        if(req.headers.origin){const expected=process.env.PUBLIC_ORIGIN||`http://${req.headers.host}`;if(new URL(req.headers.origin).host!==new URL(expected).host)throw new LobbyError('不允许跨站访问。',403);}
        if(url.pathname==='/api/session'&&req.method==='POST'){
          limit('ip:'+req.socket.remoteAddress,30);const s=lobby.createSession();json(res,201,{token:s.token,...lobby.snapshot(s)});return;
        }
        const token=/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization||'')?.[1];const s=lobby.auth(token);
        if(url.pathname==='/api/events'&&req.method==='GET'){
          if(s.streams.size>=3)throw new LobbyError('连接数过多，请关闭重复页面。',429);
          res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
          res.flushHeaders();res.on('close',()=>lobby.disconnect(s,res));lobby.connect(s,res);return;
        }
        if(url.pathname==='/api/command'&&req.method==='POST'){
          limit('user:'+s.id,120);let body='';
          for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>4096)throw new LobbyError('请求过大。',413);}
          let c;try{c=JSON.parse(body);}catch{throw new LobbyError('无效 JSON。');}
          json(res,200,lobby.command(s,c));return;
        }
        throw new LobbyError('接口不存在。',404);
      }
      if(!['GET','HEAD'].includes(req.method))throw new LobbyError('不支持的请求方法。',405);
      const file=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));
      if(!publicFiles.has(file))throw new LobbyError('文件不存在。',404);
      const content=await fs.readFile(path.join(root,file));res.writeHead(200,{'Content-Type':types[path.extname(file)],'Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:content);
    }catch(e){if(!res.headersSent)json(res,e instanceof LobbyError?e.status:500,{error:e instanceof LobbyError?e.message:'服务器暂时无法处理请求。'});else res.end();}
  });
  let ticks=0;const timer=setInterval(()=>{lobby.sweep();if(++ticks%10===0)for(const s of lobby.sessions.values())for(const res of s.streams)res.write(': heartbeat\n\n');for(const [k,v] of limits)if(v.until<Date.now())limits.delete(k);},1000);timer.unref();
  server.on('close',()=>clearInterval(timer));return {server,lobby};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {server}=createGameServer();const port=Number(process.env.PORT||5173),host=process.env.HOST||'0.0.0.0';
  server.listen(port,host,()=>console.log(`Xiangqi-Go ready on ${host}:${port}`));
  const shutdown=()=>{server.close();server.closeAllConnections();};process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
