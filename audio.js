// Original pentatonic score, synthesized locally: plucked strings and a soft flute.
// No recording, network request, or third-party music dependency.
export class GameAudio {
  constructor(){this.ctx=null;this.musicOn=true;this.effectsOn=true;this.volume=.3;this.timer=null;this.beat=0;this.next=0;}
  async unlock(){
    const Audio=globalThis.AudioContext||globalThis.webkitAudioContext;if(!Audio)return;
    if(!this.ctx){this.ctx=new Audio();this.music=this.ctx.createGain();this.music.gain.value=this.volume*.36;this.music.connect(this.ctx.destination);this.fx=this.ctx.createGain();this.fx.gain.value=.32;this.fx.connect(this.ctx.destination);}
    try{await this.ctx.resume();if(this.musicOn&&!this.timer)this.start();}catch{}
  }
  tone(freq,time,duration,gain,bus,type='sine'){
    const o=this.ctx.createOscillator(),g=this.ctx.createGain();o.type=type;o.frequency.value=freq;
    g.gain.setValueAtTime(.0001,time);g.gain.exponentialRampToValueAtTime(gain,time+.012);g.gain.exponentialRampToValueAtTime(.0001,time+duration);
    o.connect(g);g.connect(bus);o.start(time);o.stop(time+duration+.03);o.onended=()=>{o.disconnect();g.disconnect();};
  }
  pluck(midi,time,amp=1){const f=440*2**((midi-69)/12);for(const [ratio,g,d] of [[1,.24,2.3],[2,.065,1.1],[3,.026,.55],[4,.008,.25]])this.tone(f*ratio,time,d,g*amp,this.music);}
  start(){this.next=this.ctx.currentTime+.06;this.schedule();this.timer=setInterval(()=>this.schedule(),100);}
  schedule(){
    const melody=[74,null,77,81,79,null,77,74,72,null,69,72,74,null,null,null,77,null,79,84,81,null,79,77,74,null,72,69,72,null,null,null,69,null,72,74,77,null,74,72,67,null,69,72,74,null,null,null,77,null,74,72,69,null,67,69,72,null,74,77,74,null,null,null];
    if(this.next<this.ctx.currentTime)this.next=this.ctx.currentTime+.04;
    while(this.next<this.ctx.currentTime+.25){const n=this.beat%64,m=melody[n];if(m!=null)this.pluck(m,this.next);
      if(n%8===0)this.pluck([50,48,45,43,45,43,48,50][Math.floor(n/8)],this.next,.8);
      if(n%16===0){const f=440*2**((melody[n]-12-69)/12);this.tone(f,this.next+.2,3.1,.07,this.music);this.tone(f*2,this.next+.2,2.5,.012,this.music);}
      this.next+=.43;this.beat++;
    }
  }
  setMusic(on){this.musicOn=on;if(this.ctx)this.music.gain.setTargetAtTime(on?this.volume*.36:0,this.ctx.currentTime,.12);if(!on){clearInterval(this.timer);this.timer=null;}else if(this.ctx&&!this.timer)this.start();}
  setVolume(v){this.volume=v;if(this.ctx)this.music.gain.setTargetAtTime(this.musicOn?v*.36:0,this.ctx.currentTime,.06);}
  effect(kind){if(!this.ctx||!this.effectsOn)return;const t=this.ctx.currentTime;
    if(kind==='check'||kind==='win'){for(const [i,f] of (kind==='win'?[392,493.88,587.33,783.99]:[440,659.25,440]).entries())this.tone(f,t+i*.12,.5,.2,this.fx);return;}
    if(kind==='capture'){this.tone(140,t,.24,.6,this.fx,'triangle');this.tone(660,t+.05,.23,.24,this.fx);return;}
    this.tone(kind==='stone'?1100:340,t,.09,.4,this.fx,'triangle');this.tone(kind==='stone'?2400:160,t,.045,.12,this.fx);
  }
}
