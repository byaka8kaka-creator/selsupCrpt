export const fixture = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<button role="tab" data-org="A">Организация А</button><button role="tab" data-org="B"><span>Тест FBS</span></button>
<p id="token-status">Токен успешно получен: 01.01.2020 01:00:00</p>
<button data-step="1">ПОЛУЧИТЬ ТОКЕН</button>
<div id="row"><button data-step="2">Получить токен</button>
<button id="category" data-step="open" role="combobox" aria-haspopup="listbox">Одежда</button>
<button data-step="3">ПРОВЕРИТЬ СУЗ</button></div>
<div id="menu" role="listbox" hidden><div role="option">Одежда</div><div role="option" data-category="feed"><span>Корма для животных</span></div></div>
<button data-step="4">СОХРАНИТЬ</button>
<script>
window.clicks=JSON.parse(sessionStorage.getItem('clicks')||'[]');
window.tokenMode='fresh';
function format(d){return String(d.getDate()).padStart(2,'0')+'.'+String(d.getMonth()+1).padStart(2,'0')+'.'+d.getFullYear()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+':'+String(d.getSeconds()).padStart(2,'0')}
function status(time){document.querySelector('#token-status').textContent='Токен успешно получен: '+format(new Date(time))}
if(sessionStorage.getItem('tokenAt'))status(Number(sessionStorage.getItem('tokenAt')));
document.addEventListener('click',e=>{
 const el=e.target.closest('[data-org],[data-step],[data-category]');if(!el)return;
 clicks.push(el.dataset.org||el.dataset.step||'feed');sessionStorage.setItem('clicks',JSON.stringify(clicks));
 if(el.dataset.org){document.querySelector('#category').textContent=el.dataset.org==='B'?'Шины':'Одежда';}
 if(el.dataset.step==='open'){document.querySelector('#menu').hidden=false;}
 if(el.dataset.category){document.querySelector('#category').textContent='Корма для животных';document.querySelector('#menu').hidden=true;}
 if(el.dataset.step==='1' && tokenMode!=='stale'){
  const time=Date.now()+(tokenMode==='future'?6*60*1000:0);sessionStorage.setItem('tokenAt',String(time));
  if(tokenMode==='reload'){location.reload();return;}
  setTimeout(()=>status(time),200);
 }
});
</script></body></html>`;
export const sequence = ['A','1','open','feed','2','3','4','B','1','open','feed','2','3','4','A'];
