import { Terrain } from '../src/sim/terrain';
import { Aircraft, neutralInput, SimEvent } from '../src/sim/aircraft';
const t = new Terrain(7); const a = new Aircraft(t); const ev: SimEvent[] = []; const dt=1/120;
a.resetOnGround(0, 1430, 0);
const c = neutralInput(); c.throttle = 0.85;
for (let i=0;i<120*40;i++){
  const kts=a.s.vel.length()*1.944;
  c.pitch = a.s.onGround ? (kts>140?1:0) : 0;
  ev.length=0; a.step(dt,c,ev);
  for (const e of ev) console.log((i*dt).toFixed(1), JSON.stringify(e), 'kts', kts.toFixed(0), 'z', a.s.pos.z.toFixed(0));
  if (i%240===0 && i>120*14){const at=a.attitude(); console.log('t',(i*dt).toFixed(0),'kts',kts.toFixed(0),'agl ft',((a.s.pos.y-303)*3.28).toFixed(0),'pitch',at.pitch.toFixed(1),'G',a.s.gLoad.toFixed(2),'aoa',(a.s.alpha*57.3).toFixed(1));}
}
console.log('--- 9g at 350kts');
a.resetInAir(0,3000,0,0,350/1.944*1.15); c.pitch=1; c.gearDown=false;c.throttle=1;
for (let i=0;i<120*4;i++){ev.length=0;a.step(dt,c,ev); if(i%60===0) console.log('G',a.s.gLoad.toFixed(1),'aoa',(a.s.alpha*57.3).toFixed(1));}
console.log('--- landing approach');
// approach: 3 deg glide, 150 kts, aim runway
a.resetInAir(0, 303+ 6000*Math.tan(3/57.3)+3, 1500+6000, 0, 150/1.944);
c.gearDown=true; c.throttle=0.4; c.pitch=0;
let wasAir=true;
for (let i=0;i<120*140;i++){
  const s=a.s; const agl=s.pos.y-303; const dist = s.pos.z-1300; const target = 3+dist*Math.tan(3/57.3);
  const vs = s.vel.y; const wantVs = -s.vel.length()*Math.tan(3/57.3) + (target-agl)*0.1;
  c.pitch = Math.max(-1,Math.min(1,(wantVs-vs)*0.08));
  if (agl<8) c.pitch = Math.max(c.pitch, ( -1.5 - vs)*0.2 );
  const kts=s.vel.length()*1.944; c.throttle = Math.max(0,Math.min(0.84, 0.35+(150-kts)*0.02));
  if (s.onGround){c.throttle=0;c.brakes=1;c.pitch=0;}
  ev.length=0; a.step(dt,c,ev);
  for (const e of ev) console.log((i*dt).toFixed(1), JSON.stringify(e),'kts',kts.toFixed(0),'z',s.pos.z.toFixed(0));
  if(i%(120*5)===0) console.log('t',(i*dt).toFixed(0),'kts',kts.toFixed(0),'agl',agl.toFixed(0),'aoa',(s.alpha*57.3).toFixed(1),'thr',c.throttle.toFixed(2),'z',s.pos.z.toFixed(0));
  if (s.onGround && s.vel.length()<0.5){console.log('stopped at z',s.pos.z.toFixed(0),'damage',s.damage); break;}
}
