import { ImageEngine } from '../src/lib/imageEngine';
import { createDefaultEditState, DEFAULT_LOCAL_ADJUSTMENTS } from '../src/defaults';
import { makeMaskComponent, updateMaskComponent } from '../src/lib/maskMath';
import type { Mask, MaskComponent, EditState } from '../src/types';

let failed = 0, passed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  const item = document.createElement('li'); item.className = ok ? 'pass' : 'fail'; item.textContent = `${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`;
  document.querySelector('#results')!.append(item); if (ok) passed++; else failed++;
};
const source = document.createElement('canvas'); source.width = 320; source.height = 160;
const sourceContext = source.getContext('2d')!; sourceContext.fillStyle = '#606060'; sourceContext.fillRect(0, 0, 320, 160);
const blob = await new Promise<Blob>(resolve => source.toBlob(value => resolve(value!), 'image/png'));
const mask = (components: MaskComponent[]): Mask => ({id: 'test', name: 'Test mask', kind: components[0].kind, enabled: true, inverted: false, opacity: 1, overlayColor: '#ff0000', adjustments: {...DEFAULT_LOCAL_ADJUSTMENTS, exposure: 1}, components: structuredClone(components).map(c => ({...c, placed: true}))});
const linear = {...makeMaskComponent('linear'), linear: {x1: 0.2, y1: 0.5, x2: 0.8, y2: 0.5}};
const radial = {...makeMaskComponent('radial'), radial: {cx: 0.5, cy: 0.5, rx: 0.08, ry: 0.35, rotation: 90, feather: 40}};
const brush = {...makeMaskComponent('brush'), strokes: [{points: [{x: 0.5, y: 0.5}], size: 20, feather: 0, flow: 100, density: 100, erase: false}]};
const stateFor = (m?: Mask): EditState => {const s = createDefaultEditState(); s.global.sharpening = 0; s.global.colorNoiseReduction = 0; s.masks = m ? [m] : []; return s;};
const engines: {name: string; engine: ImageEngine; canvas: HTMLCanvasElement}[] = [];
try {
  for (const fallback of [false, true]) {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 160; canvas.style.width = '320px'; canvas.style.height = '160px'; document.querySelector('#canvases')!.append(canvas);
    if (fallback) { const getContext = canvas.getContext.bind(canvas); canvas.getContext = ((kind: string, options: any) => kind === 'webgl2' ? null : getContext(kind as '2d', options)) as typeof canvas.getContext; }
    const engine = new ImageEngine(canvas); engine.resize(320, 160, 1); await engine.load(blob);
    engines.push({name: fallback ? 'Canvas2D' : 'WebGL', engine, canvas});
  }
  const capture = (target: typeof engines[number], state: EditState) => {
    target.engine.render(state);
    const c = document.createElement('canvas'); c.width = 320; c.height = 160; const ctx = c.getContext('2d')!; ctx.drawImage(target.canvas, 0, 0);
    const data = ctx.getImageData(0, 0, 320, 160).data;
    return (x: number, y: number) => { const p = target.engine.imageToCanvas(x,y); const i = (Math.floor(p.y) * 320 + Math.floor(p.x)) * 4; return data[i]; };
  };
  for (const target of engines) {
    const baseline = capture(target, stateFor())(0.5, 0.5);
    check(`${target.name}: source renders`, Math.abs(baseline - 96) < 3, `${baseline}`);
    let p = capture(target, stateFor(mask([linear])));
    check(`${target.name}: linear falloff`, p(0.1,0.5) > p(0.5,0.5) && p(0.5,0.5) > p(0.9,0.5) && Math.abs(p(0.9,0.5)-baseline)<3, `${p(0.1,0.5)}, ${p(0.5,0.5)}, ${p(0.9,0.5)}`);
    p = capture(target, stateFor(mask([radial])));
    check(`${target.name}: radial rotates in pixels`, p(0.64,0.5)>baseline+5 && Math.abs(p(0.5,0.75)-baseline)<3, `${p(0.64,0.5)}, ${p(0.5,0.75)}`);
    p = capture(target, stateFor(mask([linear, {...brush, operation: 'subtract'}])));
    check(`${target.name}: subtract brush from gradient`, Math.abs(p(0.5,0.5)-baseline)<3 && p(0.5,0.25)>baseline+5);
    p = capture(target, stateFor(mask([linear, {...radial, operation: 'intersect'}])));
    check(`${target.name}: intersect gradients`, p(0.5,0.5)>baseline+5 && Math.abs(p(0.1,0.5)-baseline)<3);
    p = capture(target, stateFor({...mask([linear]), inverted: true}));
    check(`${target.name}: invert group`, p(0.9,0.5)>p(0.1,0.5));
    p = capture(target, stateFor(mask([{...linear, inverted: true}])));
    check(`${target.name}: invert component`, p(0.9,0.5)>p(0.1,0.5));
    p = capture(target, stateFor({...mask([linear]), amount: 0, curve: [{x:0,y:0.5},{x:1,y:1}]}));
    check(`${target.name}: amount zero is neutral including curve`, Math.abs(p(0.1,0.5)-baseline)<3);
    p = capture(target, stateFor({...mask([linear]), adjustments: {...DEFAULT_LOCAL_ADJUSTMENTS}, curve: [{x:0,y:0.2},{x:1,y:1}]}));
    check(`${target.name}: local curve only changes selected pixels`, p(0.1,0.5)>baseline+10 && Math.abs(p(0.9,0.5)-baseline)<3);
    p = capture(target, stateFor({...mask([linear]), enabled:false}));
    check(`${target.name}: disabled masks are neutral`, Math.abs(p(0.1,0.5)-baseline)<3);
    const m = mask([brush]); m.components![0].strokes!.push({...brush.strokes[0], erase:true});
    p = capture(target, stateFor(m)); check(`${target.name}: erase clears brush`, Math.abs(p(0.5,0.5)-baseline)<3);
  }
  for (const components of [[linear], [radial], [linear, {...radial, operation:'intersect' as const}]]) {
    const state = stateFor({...mask(components), curve:[{x:0,y:0.1},{x:0.5,y:0.6},{x:1,y:1}]});
    const a = capture(engines[0],state), b = capture(engines[1],state);
    let max = 0; for (let y=0.1;y<1;y+=0.1) for (let x=0.1;x<1;x+=0.1) max=Math.max(max,Math.abs(a(x,y)-b(x,y)));
    check(`GPU / fallback agree for ${components.map(c=>c.kind).join('+')}`, max<=4, `maximum pixel delta: ${max}`);
  }
  for (const target of engines) {
    const baseline = capture(target, stateFor())(0.5, 0.5);
    let p = capture(target, stateFor({...mask([linear]), components:[{...linear, placed:false}]}));
    check(`${target.name}: unplaced gradients have no effect`, Math.abs(p(0.1,0.5)-baseline)<3);
    p = capture(target, stateFor(mask([{...linear, linear:{x1:1.2,y1:0.5,x2:1.5,y2:0.5}}])));
    check(`${target.name}: off-image linear gradient covers the frame`, p(0.1,0.5)>baseline+10 && p(0.9,0.5)>baseline+10);
    const grainMask = {...mask([linear]), adjustments:{...DEFAULT_LOCAL_ADJUSTMENTS}, grain:{amount:100,size:25,roughness:100}};
    p = capture(target, stateFor(grainMask));
    let variation = 0; for (let x=0.02;x<0.18;x+=0.01) variation=Math.max(variation,Math.abs(p(x,0.5)-baseline));
    check(`${target.name}: local grain changes selected pixels`, variation>2 && Math.abs(p(0.9,0.5)-baseline)<3);
    const state=stateFor(mask([radial])); state.geometry.rotate=12; state.geometry.flipX=true; state.crop={...state.crop,x:0.1,y:0.1,width:0.8,height:0.8};
    p=capture(target,state);
    const canvasPoint=target.engine.imageToCanvas(0.5,0.5), sourcePoint=target.engine.canvasToImage(canvasPoint.x,canvasPoint.y,true);
    check(`${target.name}: mask stays aligned after crop, rotation and flip`, Math.abs(sourcePoint.x-0.5)<1e-6 && Math.abs(sourcePoint.y-0.5)<1e-6 && p(0.5,0.5)>baseline+10);
  }
  const exportBlob = await engines[0].engine.export(blob, stateFor(mask([linear])), {format:'image/png',quality:100,resizeMode:'original',longEdge:320,width:320,height:160,fileName:'mask-check',includeMetadata:false,watermarkEnabled:false,watermarkText:'',watermarkOpacity:100,watermarkPosition:'center'});
  const bitmap = await createImageBitmap(exportBlob); const c = document.createElement('canvas'); c.width=bitmap.width;c.height=bitmap.height;const ctx=c.getContext('2d')!;ctx.drawImage(bitmap,0,0); const data=ctx.getImageData(0,0,c.width,c.height).data;
  check('PNG export retains gradient at original resolution', bitmap.width===320 && bitmap.height===160 && data[(80*320+32)*4]>data[(80*320+288)*4]+10); bitmap.close();
  // Reused textures must match a fresh render after every kind of invalidation.
  for (const target of engines) {
    const initial = mask([linear, {...brush, operation:'subtract'}]);
    const component = initial.components![1];
    const paint = {...brush.strokes[0], feather:75, flow:30, points:[{x:0.2,y:0.7}]};
    const added = updateMaskComponent(initial, component.id, {strokes:[...component.strokes!, paint]});
    const extended = updateMaskComponent(initial, component.id, {strokes:[...component.strokes!, {...paint,points:[...paint.points,{x:0.8,y:0.7}]}]});
    const altered = updateMaskComponent(extended, component.id, {inverted:true,opacity:0.35});
    const cases:[string,EditState][] = [
      ['initial compound',stateFor(initial)], ['new stroke',stateFor(added)], ['extend stroke',stateFor(extended)],
      ['undo stroke',stateFor(initial)], ['redo stroke',stateFor(extended)], ['invert / opacity',stateFor(altered)],
      ['disable component',stateFor(updateMaskComponent(extended,component.id,{enabled:false}))],
      ['restore component',stateFor(extended)], ['standalone gradient',stateFor(mask([radial]))],
      ['compound after analytic',stateFor(extended)],
      ['duplicate IDs across groups',{...stateFor(initial),masks:[initial,{...extended,id:'second'}]}],
      ['reorder groups',{...stateFor(initial),masks:[{...extended,id:'second'},initial]}],
      ['delete all masks',stateFor()], ['restore masks',stateFor(extended)],
    ];
    for (const [name,state] of cases) {
      const live = capture(target,state);
      // Loading the same source resets all image-dependent mask caches.
      const referenceTarget = engines.find(e=>e!==target)!;
      await referenceTarget.engine.load(blob);
      const fresh = capture(referenceTarget,structuredClone(state));
      let max=0;for(let y=0.1;y<1;y+=0.08)for(let x=0.1;x<1;x+=0.08)max=Math.max(max,Math.abs(live(x,y)-fresh(x,y)));
      check(`${target.name}: cached ${name} matches fresh renderer`,max<=4,`maximum pixel delta: ${max}`);
    }
  }
  // A colored fine-detail image exercises every local adjustment family.
  const pattern=sourceContext.createImageData(320,160);
  for(let y=0;y<160;y++) for(let x=0;x<320;x++) {
    const i=(y*320+x)*4, stripe=((x+y)%3)*28;
    pattern.data[i]=50+(x%100)+stripe; pattern.data[i+1]=35+(y%80);pattern.data[i+2]=80+stripe;pattern.data[i+3]=255; if ((x+y)%7 < 2) { pattern.data[i]=230; pattern.data[i+1]=215; pattern.data[i+2]=240; }
  }
  sourceContext.putImageData(pattern,0,0);
  const patternBlob=await new Promise<Blob>(resolve=>source.toBlob(value=>resolve(value!),'image/png'));
  const adjustments={exposure:1, contrast:60, highlights:-80, shadows:80, whites:80, blacks:-60, temperature:80, tint:80, hue:120, vibrance:80, saturation:-80, texture:-100, clarity:-100, dehaze:-80, sharpness:100, noiseReduction:100, moire:100, defringe:100};
  for(const target of engines) {
    await target.engine.load(patternBlob);
    const base=capture(target,stateFor());
    for(const [key,value] of Object.entries(adjustments)) {
      const p=capture(target,stateFor({...mask([linear]),adjustments:{...DEFAULT_LOCAL_ADJUSTMENTS,[key]:value}}));
      let inside=0,outside=0;
      for(let y=0.2;y<0.8;y+=0.1) for(let x=0.02;x<0.18;x+=0.02) {inside=Math.max(inside,Math.abs(p(x,y)-base(x,y)));outside=Math.max(outside,Math.abs(p(x+0.8,y)-base(x+0.8,y)));}
      check(`${target.name}: ${key} responds locally`,inside>0 && outside<=1,`selected delta ${inside}, outside delta ${outside}`);
    }
  }
} catch(error) {check('Renderer completed without runtime error',false,String(error));}
document.querySelector('#status')!.textContent=`${passed} passed, ${failed} failed`;
