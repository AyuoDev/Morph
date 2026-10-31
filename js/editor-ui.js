
const modeNames={base:'Base meshes',customize:'Shape & details',clothes:'Appearance',materials:'Materials',animations:'Animations',randomizer:'Randomize'};
const search=document.getElementById('library-search');
function filterLibrary(){
  const query=search.value.trim().toLowerCase();
  document.querySelectorAll('.panel.active .base-mesh-card,.panel.active .clothes-category,.panel.active .animation-card,.panel.active .clothing-card').forEach(card=>{card.hidden=!!query&&!card.textContent.toLowerCase().includes(query);});
}
search.addEventListener('input',filterLibrary);
new MutationObserver(filterLibrary).observe(document.getElementById('basemesh-panel'),{childList:true,subtree:true});
document.querySelectorAll('.tool-rail [data-mode]').forEach(button=>button.addEventListener('click',()=>{
  const mode=button.dataset.mode;document.body.dataset.mode=mode;
  document.getElementById('library-title').textContent=modeNames[mode];search.value='';
  search.hidden=!['base','clothes','animations'].includes(mode);
  document.querySelectorAll('.tool-rail [data-mode]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));
  requestAnimationFrame(()=>{filterLibrary();window.dispatchEvent(new Event('resize'));});
}));
const help=document.getElementById('editor-help');
document.getElementById('help-button').addEventListener('click',()=>help.showModal());
help.querySelector('button').addEventListener('click',()=>help.close());
document.querySelectorAll('.icon-btn,.preset-close,.export-panel-close-btn').forEach(button=>{if(!button.hasAttribute('aria-label'))button.setAttribute('aria-label','Close dialog');});
document.getElementById('user-btn').setAttribute('aria-label','Account menu');
document.getElementById('credits-btn').setAttribute('aria-label','Credits and membership');
document.getElementById('auth-email').setAttribute('aria-label','Email address');
document.getElementById('auth-email').autocomplete='email';
document.getElementById('auth-password').setAttribute('aria-label','Password');
document.querySelectorAll('.export-type-card').forEach(card=>{card.tabIndex=0;card.setAttribute('role','button');card.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();card.click();}});});
