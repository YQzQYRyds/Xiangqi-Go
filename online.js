export class OnlineConnection {
  constructor(onState,onStatus){this.onState=onState;this.onStatus=onStatus;this.token=null;this.enabled=false;this.controller=null;this.retry=null;this.version=-1;}
  accept(state){if(state.version<=this.version)return;this.version=state.version;this.onState(state);}
  async start(){if(this.enabled)return;this.enabled=true;try{this.token=sessionStorage.getItem('xiangqi-online-token');}catch{}await this.connect();}
  async connect(){
    if(!this.enabled)return;this.onStatus(false,'正在连接大厅…');this.controller=new AbortController();
    try{
      if(!this.token){const res=await fetch('/api/session',{method:'POST',signal:this.controller.signal});const data=await res.json();if(!res.ok)throw Error(data.error);this.token=data.token;this.version=-1;try{sessionStorage.setItem('xiangqi-online-token',this.token);}catch{}this.accept(data);}
      const res=await fetch('/api/events',{headers:{Authorization:`Bearer ${this.token}`},signal:this.controller.signal});
      if(res.status===401){this.token=null;this.version=-1;throw Error('身份已过期，正在重建连接…');}
      if(!res.ok)throw Error('连接失败，正在重试…');
      this.onStatus(true,'已连接');const reader=res.body.getReader(),decoder=new TextDecoder();let buffer='';
      while(this.enabled){const {done,value}=await reader.read();if(done)throw Error('连接中断，正在重连…');buffer+=decoder.decode(value,{stream:true});let end;
        while((end=buffer.indexOf('\n\n'))>=0){const event=buffer.slice(0,end);buffer=buffer.slice(end+2);if(event.startsWith('data: '))this.accept(JSON.parse(event.slice(6)));}
      }
    }catch(e){if(!this.enabled)return;this.onStatus(false,e.message||'连接中断，正在重连…');this.retry=setTimeout(()=>this.connect(),2000);}
  }
  async command(type,data={}){
    const requestId=globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const res=await fetch('/api/command',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${this.token}`},body:JSON.stringify({type,...data,requestId}),signal:AbortSignal.timeout(10000)});
    const result=await res.json();if(!res.ok)throw Error(result.error||'操作失败');this.accept(result);return result;
  }
  stop(){this.enabled=false;this.controller?.abort();clearTimeout(this.retry);}
}
