
const newsletterEndpoint='https://yjrqcmzkmfawwsppmnkl.supabase.co/rest/v1/newsletter?on_conflict=email';
const newsletterPublicKey='sb_publishable_fIkpyaJmmkNhcB1HOeRrKw_xZ0c0miD';
const form=document.getElementById('newsletter-form');
form.addEventListener('submit',async event=>{
  event.preventDefault();if(!form.reportValidity()||form.dataset.submitting==='true')return;
  const input=document.getElementById('newsletter-email'),button=document.getElementById('newsletter-btn'),status=document.getElementById('newsletter-status');
  form.dataset.submitting='true';button.disabled=true;button.textContent='Subscribing…';status.textContent='';status.style.color='';
  try{
    const response=await fetch(newsletterEndpoint,{method:'POST',headers:{apikey:newsletterPublicKey,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({email:input.value.trim()}),signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(`Newsletter request failed (${response.status})`);
    status.style.color='#c5f277';status.textContent='You’re on the list. Thanks for following the journey!';input.value='';
  }catch{status.style.color='#ffb0a7';status.textContent='Could not subscribe right now. Please try again shortly.';}
  finally{button.disabled=false;button.textContent='Join the list ↗';delete form.dataset.submitting;}
});
