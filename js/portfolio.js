const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
if (!reducedMotion.matches && 'IntersectionObserver' in window) {
  document.documentElement.classList.add('js-motion');
  const observer = new IntersectionObserver(entries => entries.forEach(entry => {
    if (entry.isIntersecting) { entry.target.classList.add('visible'); observer.unobserve(entry.target); }
  }), { threshold: 0.06 });
  document.querySelectorAll('.reveal').forEach(el => observer.observe(el));
}

const canvas=document.getElementById('network-canvas'),ctx=canvas.getContext('2d');
const nodes=[...document.querySelectorAll('.network-project')],pause=document.getElementById('pause-network');
let angle=.35,paused=reducedMotion.matches,lastTime=0;
const points=[],rings=7,segments=12;
for(let row=0;row<=rings;row++)for(let col=0;col<segments;col++){
  const lat=Math.PI*row/rings,lon=Math.PI*2*(col+(row%2)*.5)/segments;
  points.push([Math.sin(lat)*Math.cos(lon),Math.cos(lat),Math.sin(lat)*Math.sin(lon)]);
}
function project([x,y,z],width,height){
  const rx=x*Math.cos(angle)+z*Math.sin(angle),rz=-x*Math.sin(angle)+z*Math.cos(angle);
  const ry=y*.94-rz*.342,depth=y*.342+rz*.94,scale=3.7/(3.7-depth),radius=Math.min(width*.39,height*.41);
  return{x:width/2+rx*radius*scale,y:height/2-ry*radius*scale,z:depth,scale};
}
function draw(){
  const width=canvas.clientWidth,height=canvas.clientHeight,dpr=Math.min(devicePixelRatio||1,2);
  if(canvas.width!==Math.round(width*dpr)||canvas.height!==Math.round(height*dpr)){canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);}
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
  const projected=points.map(p=>project(p,width,height));
  projected.forEach((p,i)=>{
    const row=Math.floor(i/segments),col=i%segments,neighbors=[row*segments+(col+1)%segments];
    if(row<rings)neighbors.push(i+segments,(row+1)*segments+(col+(row%2?1:segments-1))%segments);
    neighbors.forEach(j=>{const q=projected[j];ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);ctx.strokeStyle=`rgba(174,163,210,${.09+(p.z+q.z+2)*.065})`;ctx.lineWidth=.7;ctx.stroke();});
    ctx.beginPath();ctx.arc(p.x,p.y,p.z>0?2:1.2,0,Math.PI*2);ctx.fillStyle=p.z>.3?'#c5f277':'#8e83ac';ctx.fill();
  });
  [points[26],points[56],points[44]].forEach((point,i)=>{const node=nodes[i];if(!node)return;const p=project(point,width,height),x=Math.max(node.offsetWidth/2+4,Math.min(width-node.offsetWidth/2-4,p.x));node.style.transform=`translate(calc(-50% + ${x-width/2}px),calc(-50% + ${p.y-height/2}px)) scale(${.9+p.scale*.1})`;node.style.zIndex=p.z>0?'3':'2';});
}
function tick(time){if(!paused&&!document.hidden)angle+=Math.min(time-lastTime,40)*.00012;lastTime=time;draw();requestAnimationFrame(tick);}
function syncPause(){pause.setAttribute('aria-pressed',String(paused));pause.textContent=paused?'Resume rotation ▷':'Pause rotation Ⅱ';}
pause.addEventListener('click',()=>{paused=!paused;syncPause();draw();});reducedMotion.addEventListener('change',e=>{paused=e.matches;syncPause();});syncPause();new ResizeObserver(draw).observe(canvas);requestAnimationFrame(tick);
const dialog=document.getElementById('media-dialog'),content=document.getElementById('media-content');
document.querySelectorAll('.image-open').forEach(button=>button.addEventListener('click',()=>{const image=button.querySelector('img').cloneNode();image.loading='eager';content.replaceChildren(image);dialog.showModal();}));
document.querySelectorAll('[data-video]').forEach(button=>button.addEventListener('click',()=>{const iframe=document.createElement('iframe');iframe.src=`https://www.youtube-nocookie.com/embed/${button.dataset.video}?autoplay=1`;iframe.title='Hack it Tycoon trailer';iframe.allow='autoplay; encrypted-media; picture-in-picture; fullscreen';iframe.allowFullscreen=true;content.replaceChildren(iframe);dialog.showModal();}));
dialog.querySelector('.dialog-close').addEventListener('click',()=>dialog.close());dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});dialog.addEventListener('close',()=>content.replaceChildren());

const carousel=document.getElementById('asset-carousel'),pauseAssets=document.getElementById('assets-pause');
if(carousel&&pauseAssets){
  let stopped=matchMedia('(prefers-reduced-motion: reduce)').matches,hovered=false;
  const setStopped=value=>{stopped=value;pauseAssets.setAttribute('aria-pressed',String(stopped));pauseAssets.textContent=stopped?'Resume auto-scroll':'Pause auto-scroll';};
  const move=direction=>carousel.scrollBy({left:direction*Math.max(220,carousel.clientWidth*.72),behavior:reducedMotion.matches?'instant':'smooth'});
  document.getElementById('assets-back').addEventListener('click',()=>move(-1));
  document.getElementById('assets-forward').addEventListener('click',()=>move(1));
  pauseAssets.addEventListener('click',()=>setStopped(!stopped));
  carousel.addEventListener('mouseenter',()=>{hovered=true;});carousel.addEventListener('mouseleave',()=>{hovered=false;});
  carousel.addEventListener('focusin',()=>{hovered=true;});carousel.addEventListener('focusout',e=>{if(!carousel.contains(e.relatedTarget))hovered=false;});
  setInterval(()=>{if(stopped||hovered||document.hidden)return;const end=carousel.scrollWidth-carousel.clientWidth;if(carousel.scrollLeft>=end-10)carousel.scrollTo({left:0,behavior:'smooth'});else move(1);},4200);
  setStopped(stopped);
}
