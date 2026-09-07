import { ImageEngine } from '../src/lib/imageEngine';
import { createDefaultEditState, DEFAULT_LOCAL_ADJUSTMENTS } from '../src/defaults';
import { makeMaskComponent, updateMaskComponent } from '../src/lib/maskMath';
import type { BrushStroke, Mask, MaskComponent, EditState } from '../src/types';

const canvas = document.querySelector<HTMLCanvasElement>('#preview')!;
const source = document.createElement('canvas'); source.width=1800;source.height=1200;
const ctx=source.getContext('2d')!; const gradient=ctx.createLinearGradient(0,0,1800,1200);
gradient.addColorStop(0,'#a4c5d5');gradient.addColorStop(1,'#373b32');ctx.fillStyle=gradient;ctx.fillRect(0,0,1800,1200);
const blob=await new Promise<Blob>(resolve=>source.toBlob(b=>resolve(b!)));
const engine=new ImageEngine(canvas);engine.resize(1200,800,1);await engine.load(blob);
const gl=canvas.getContext('webgl2')!;
const stroke=(index:number, count=80):BrushStroke=>({size:8,feather:75,flow:30,density:85,erase:index%7===6,points:Array.from({length:count},(_,p)=>({x:0.1+p/100,y:0.2+index/50+Math.sin(p/12)*0.04}))});
const brush={...makeMaskComponent('brush'),strokes:Array.from({length:24},(_,i)=>stroke(i))};
const linear={...makeMaskComponent('linear'),placed:true};
const radial={...makeMaskComponent('radial'),placed:true};
const group=(id:string,components:MaskComponent[]):Mask=>({id,name:id,kind:components[0].kind,enabled:true,inverted:false,opacity:1,adjustments:{...DEFAULT_LOCAL_ADJUSTMENTS,exposure:0.5},components});
const base=createDefaultEditState();
const bench=async(name:string, initial:EditState, next:(frame:number)=>EditState)=>{
  engine.render(initial);gl.finish();
  const samples:number[]=[];
  for(let i=0;i<24;i++) {
    await new Promise(requestAnimationFrame);
    const start=performance.now();engine.render(next(i));gl.finish();
    if(i>=4)samples.push(performance.now()-start);
  }
  samples.sort((a,b)=>a-b);
  const row=document.createElement('tr');row.innerHTML=`<td>${name}</td><td>${samples[10].toFixed(1)} ms</td><td>${samples[18].toFixed(1)} ms</td>`;document.querySelector('#results')!.append(row);
};
try {
  const m=group('Brush',[brush]);
  await bench('Brush: growing stroke after 24 saved strokes',{...base,masks:[m]},i=>({...base,masks:[updateMaskComponent(m,brush.id,{strokes:[...brush.strokes,stroke(25,20+i*3)]})]}));
  const compound=group('Gradient with subtract brush',[linear,{...brush,operation:'subtract'}]);
  const masks=[compound,group('Other brush',[{...brush,id:'other-brush'}]),group('Radial',[radial])];
  await bench('Compound mask: growing subtract brush',{...base,masks},i=>({...base,masks:[updateMaskComponent(compound,brush.id,{strokes:[...brush.strokes,stroke(25,20+i*3)]}),...masks.slice(1)]}));
  await bench('Compound mask: move gradient beside saved brush',{...base,masks},i=>({...base,masks:[updateMaskComponent(compound,linear.id,{linear:{...linear.linear!,y1:0.1+i*0.005}}),...masks.slice(1)]}));
  await bench('Standalone radial: rotate',{...base,masks:[group('Radial',[radial])]},i=>({...base,masks:[group('Radial',[{...radial,radial:{...radial.radial!,rotation:i*3}}])]}));
  await bench('Exposure slider: three masks',{...base,masks},i=>({...base,global:{...base.global,exposure:i*0.04},masks}));
  document.querySelector('#status')!.textContent='Complete';
}catch(error){document.querySelector('#status')!.textContent=String(error);}
