'use strict';
/* Meu Treino 3 — autenticacao e sync. NAO toca na chave meu_treino_v2. */
(() => {
  const CONF = window.MEU_TREINO_SUPABASE || {};
  const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test((CONF.url||'').replace(/\/$/,''))
    && typeof CONF.anonKey === 'string' && CONF.anonKey.length > 30 && !CONF.anonKey.startsWith('COLE_');
  const API = (CONF.url||'').replace(/\/$/,'');
  const sessionKey = 'meu_treino_v3_session';
  let session = null, revision = 0, dirty = false, active = false, busy = false, blocked = false, deleting = false;
  let syncTimer = null, refreshPromise = null, epoch = 0, cloudMessage = '', mode = 'entry';
  const OLD_KEY = 'meu_treino_v2';
  const GUEST_KEY = 'meu_treino_v3_guest';
  const safe = s => esc(s);
  const userCacheKey = id => 'meu_treino_v3_user_' + id;
  const pendingKey = id => 'meu_treino_v3_pending_' + id;
  const storage = {get(k){try{return localStorage.getItem(k)}catch{return null}},set(k,v){try{localStorage.setItem(k,v)}catch{}},del(k){try{localStorage.removeItem(k)}catch{}}};
  function snapshot(){return clone(state)}
  function hydrate(data){
    // Validate before adopting any imported state; do not take code or markup from it.
    if(!data || typeof data !== 'object' || Array.isArray(data) || !data.workouts || typeof data.workouts!=='object' || Array.isArray(data.workouts)) throw Error('Arquivo de treino inválido');
    let obj = clone(data);
    obj.workouts = normalizeWorkouts(obj.workouts);
    obj.logs = Array.isArray(obj.logs) ? obj.logs : [];
    obj.drafts = obj.drafts && typeof obj.drafts === 'object' && !Array.isArray(obj.drafts) ? obj.drafts : {};
    obj.runLogs = Array.isArray(obj.runLogs) ? obj.runLogs : [];
    obj.weights = Array.isArray(obj.weights) ? obj.weights : [];
    obj.runWeek = Number(obj.runWeek)||1;
    obj.restSeconds = Number(obj.restSeconds)||90;
    obj.migrations = Array.isArray(obj.migrations) ? obj.migrations : [];
    return obj;
  }
  function setLocal(data){state=hydrate(data);if(key!==GUEST_KEY)storage.set(key,JSON.stringify(state));selected=Object.keys(state.workouts)[0]||'RUN';showPage('inicio');if(key!==GUEST_KEY){mode='user';showEntry('ready')}}
  function getV2(){try{const raw=storage.get(OLD_KEY);if(!raw)return null;const d=JSON.parse(raw);return hydrate(d)}catch{return null}}
  function counts(s){return {treinos:Object.keys(s.workouts||{}).length,sessoes:(s.logs||[]).length,corridas:(s.runLogs||[]).length,pesos:(s.weights||[]).length}}
  function summarize(s){const c=counts(s);return `${c.treinos} fichas · ${c.sessoes} treinos · ${c.corridas} corridas · ${c.pesos} pesagens`}
  function download(data, name){const file=new Blob([JSON.stringify({version:3,exportedAt:new Date().toISOString(),data},null,2)],{type:'application/json'});const url=URL.createObjectURL(file),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000)}
  function saveAllBackup(){download(snapshot(),'meu-treino-3-backup-'+today()+'.json')}
  function isPending(){return session && storage.get(pendingKey(session.user.id))==='1'}
  function markPending(){if(session)storage.set(pendingKey(session.user.id),'1')}
  function clearPending(){if(session)storage.del(pendingKey(session.user.id))}
  // Entrada centralizada: nenhuma ficha aparece até o usuário optar por entrar ou visitar.
  // No modo visitante todos os registros ficam somente em memória; recarregar descarta tudo.

function showEntry(status='choose',notice=''){
  const gate=$('entryGate');if(!gate)return;
  if(status==='ready'){
    document.body.classList.remove('entry-locked');gate.hidden=true;gate.innerHTML='';return;
  }
  gate.hidden=false;document.body.classList.add('entry-locked');
  const loading=status==='loading';
  gate.innerHTML=`<div class="entry-panel entry-panel--art">
    ${notice?`<div class="entry-notice" role="alert">${safe(notice)}</div>`:''}
    ${loading?`<div class="entry-status" role="status">Verificando sua sessão…</div>`:`
      <form id="gateAuthForm" class="entry-form-overlay">
        <label class="sr-only" for="gateEmail">E-mail</label>
        <input type="email" id="gateEmail" class="entry-hit entry-input entry-email" autocomplete="email" placeholder="voce@email.com" aria-label="E-mail" required>
        <label class="sr-only" for="gatePassword">Senha</label>
        <input id="gatePassword" type="password" class="entry-hit entry-input entry-password" minlength="8" autocomplete="current-password" placeholder="Sua senha" aria-label="Senha" required>
        <button type="submit" id="gateSubmit" class="entry-hit entry-button entry-submit">Entrar</button>
        <button type="button" id="gateSignup" class="entry-hit entry-button entry-signup">Criar conta gratuita</button>
        <button type="button" id="gateGuest" class="entry-hit entry-button entry-guest">Continuar sem cadastro</button>
        <button type="button" id="gateForgot" class="entry-hit entry-link entry-forgot">Esqueci minha senha</button>
        <p id="gateAuthMessage" class="entry-notice" role="status" aria-live="polite" style="display:none"></p>
      </form>`}
    <div class="entry-credit-overlay" aria-hidden="true"></div>
  </div>`;
  if(!loading){
    $('gateSignup').onclick=()=>accountPanel('up');
    $('gateGuest').onclick=enterGuest;
    $('gateForgot').onclick=()=>accountPanel('forgot');
    $('gateAuthForm').onsubmit=async e=>{e.preventDefault();const submit=$('gateSubmit');submit.disabled=true;const m=$('gateAuthMessage');m.style.display='block';msg(m,'Entrando…');
      try{
        const email=$('gateEmail').value.trim(),password=$('gatePassword').value;
        const resp=await request('POST','/auth/v1/token?grant_type=password',{email,password},false);
        await login(resp);
      }catch(err){m.style.display='block';msg(m,friendly(err))}
      finally{if(submit.isConnected)submit.disabled=false}
    };
  }
}
  function enterGuest(){
    if(session)return;
    clearTimeout(syncTimer);mode='guest';key=GUEST_KEY;
    state=hydrate(fresh());selected=Object.keys(state.workouts)[0]||'RUN';
    dirty=false;active=false;blocked=false;revision=0;cloudMessage='';
    showEntry('ready');showPage('inicio');printBar();
  }
  function exitGuest(){
    if(session)return;
    if(!confirm('Sair do modo visitante? Os registros temporários serão perdidos.'))return;
    state=hydrate(fresh());key=GUEST_KEY;selected='A';mode='entry';cloudMessage='';
    closeModal();showEntry('choose');printBar();
  }
  function printBar(){
    const status = !configured ? 'Banco não configurado' : blocked ? 'Conflito de versões' : !session ? 'Não salva dados' : !navigator.onLine ? 'Offline (cópia local)' : dirty||busy ? 'Sincronização pendente' : 'Sincronizado';
    $('accountbar').innerHTML = `<div class="cloudbar"><div><b>${session ? '☁ Conta conectada' : '▣ Meu Treino 3.5.1'}</b><div class="tag">${session ? safe(session.user.email || 'Usuário') : 'Visitante · registros temporários'} · ${safe(status)}</div></div><button class="btn secondary sm" id="openAccount">${session ? 'Minha conta' : 'Entrar / criar conta'}</button></div>`;
    $('openAccount').onclick=()=>accountPanel();
    const m = $('cloudnotice');
    if(blocked){m.innerHTML=`<div class="cloudnotice error"><b>Sincronização pausada:</b> outra alteração foi encontrada na nuvem. Seus dados continuam salvos no aparelho. <button class="btn sm secondary" id="resolveConflict">Resolver</button></div>`;$('resolveConflict').onclick=()=>conflictPanel()}
    else if(cloudMessage){m.innerHTML=`<div class="cloudnotice">${safe(cloudMessage)}</div>`}
    else if(session && (dirty||!navigator.onLine)){m.innerHTML=`<div class="cloudnotice">${navigator.onLine?'Alterações salvas no aparelho, aguardando sincronização.':'Sem internet. Você pode continuar treinando; os registros serão enviados quando houver conexão.'}</div>`}
    else m.innerHTML='';
  }
  function modal(body){$('cloudmodal').innerHTML=`<div class="clouddialog"><div class="dialog">${body}</div></div>`;const close=$('closeCloud');if(close)close.onclick=closeModal}
  function closeModal(){$('cloudmodal').innerHTML=''}
  function msg(el,str){if(el)el.textContent=str}
  function accountPanel(initialMode='in'){
    if(!configured){modal(`<div class="flex"><h2>Configuração necessária</h2><button id="closeCloud" class="btn secondary sm">Fechar</button></div><p>O aplicativo já funciona localmente. Para habilitar cadastro público e nuvem, configure o projeto Supabase no arquivo <code>v3/config.js</code> e execute o SQL incluído no pacote.</p><button id="backupAccount" class="btn secondary">Exportar meus dados</button>`);$('backupAccount').onclick=saveAllBackup;return}
    if(session){
      modal(`<div class="flex"><h2>Minha conta</h2><button id="closeCloud" class="btn secondary sm">✕</button></div><p class="muted small">${safe(session.user.email||'')}</p><div class="barline"><b>Estado</b><p>${blocked?'Conflito pendente':dirty?'Alterações locais aguardando nuvem':'Sincronizado'} · Revisão ${revision}</p></div><div class="stack" style="margin-top:12px"><button class="btn" id="syncNow" ${blocked?'disabled':''}>Sincronizar agora</button><button class="btn secondary" id="reloadCloud">Atualizar dados da nuvem</button><button class="btn secondary" id="importV2">Importar meu histórico 2.0</button><button class="btn secondary" id="exportNow">Exportar backup</button><button class="btn secondary" id="recoverPwd">Alterar minha senha</button><button class="btn danger" id="deleteAccount">Excluir minha conta e meus dados</button><button class="btn secondary" id="logoutCloud">Sair da conta</button></div>`);
      $('syncNow').onclick=()=>{closeModal();syncSoon(0)};
      $('reloadCloud').onclick=()=>reloadFromCloud();$('importV2').onclick=()=>migrationPanel();$('exportNow').onclick=saveAllBackup;
      $('recoverPwd').onclick=()=>resetPasswordPanel();$('deleteAccount').onclick=()=>deleteAccountPanel();$('logoutCloud').onclick=()=>logout();return
    }
    modal(`<div class="flex"><h2>Entre ou crie sua conta</h2><button id="closeCloud" class="btn secondary sm">✕</button></div><p class="muted small">Cada usuário tem suas próprias fichas e dados protegidos por regras no banco de dados.</p><div class="tabs"><button id="tabIn" class="tab active">Entrar</button><button id="tabUp" class="tab">Criar conta</button><button id="tabForgot" class="tab">Recuperar acesso</button></div><form id="authForm" class="stack"><div><label>E-mail</label><input type="email" id="emailAuth" autocomplete="email" required placeholder="voce@email.com"></div><div id="pwdBlock"><label>Senha (mínimo 8 caracteres)</label><input type="password" id="passAuth" autocomplete="current-password" minlength="8" required></div><p id="authResult" class="small" role="status"></p><button class="btn full" id="submitAuth" type="submit">Entrar</button></form><p class="small muted">Seus dados da versão 2.0 não serão apagados. Você poderá importá-los depois de entrar.</p>${mode==='guest'?'<p class="small muted">Os dados temporários do visitante não serão transferidos para a conta.</p><button type="button" class="btn secondary full" id="returnWelcome">Sair do modo visitante</button>':''}`);
    let formMode='in';function toggle(m){formMode=m;for(const t of ['In','Up','Forgot'])$('tab'+t).classList.toggle('active',t.toLowerCase()===(m==='forgot'?'forgot':m));$('pwdBlock').hidden=m==='forgot';$('passAuth').required=m!=='forgot';$('passAuth').autocomplete=m==='up'?'new-password':'current-password';$('submitAuth').textContent=m==='in'?'Entrar':m==='up'?'Criar conta':'Enviar link';msg($('authResult'),'')}
    $('tabIn').onclick=()=>toggle('in');$('tabUp').onclick=()=>toggle('up');$('tabForgot').onclick=()=>toggle('forgot');if($('returnWelcome'))$('returnWelcome').onclick=exitGuest;toggle(initialMode==='up'?'up':initialMode==='forgot'?'forgot':'in');
    $('authForm').onsubmit=async e=>{e.preventDefault();const email=$('emailAuth').value.trim(),password=$('passAuth').value;const btn=$('submitAuth');btn.disabled=true;msg($('authResult'),'Processando…');try{
      if(formMode==='forgot'){await request('POST','/auth/v1/recover?redirect_to='+encodeURIComponent(location.origin+location.pathname),{email},false);msg($('authResult'),'Se o endereço existir, você receberá um e-mail de recuperação. Verifique o spam.');return}
      if(formMode==='up'){const resp=await request('POST','/auth/v1/signup?redirect_to='+encodeURIComponent(location.origin+location.pathname),{email,password},false);if(!resp.access_token){msg($('authResult'),'Verifique seu e-mail para confirmar o cadastro e depois entre.');return}await login(resp);return}
      const resp=await request('POST','/auth/v1/token?grant_type=password',{email,password},false);await login(resp);
    }catch(err){msg($('authResult'),friendly(err))}finally{btn.disabled=false}}
  }
  function friendly(err){const str=String(err?.message||err||'Erro inesperado');if(/invalid login/i.test(str))return 'E-mail ou senha incorretos.';if(/email not confirmed/i.test(str))return 'Confirme seu e-mail antes de entrar.';if(/failed to fetch/i.test(str))return 'Não foi possível conectar. Confira internet e configuração Supabase.';return str.slice(0,220)}
  async function request(method,path,body,auth=true){
    if(!configured)throw Error('Supabase não configurado');
    let token = null;if(auth){token=await validToken();if(!token)throw Error('Sessão expirada. Entre novamente.');}
    const headers={'apikey':CONF.anonKey,'Content-Type':'application/json'};
    if(token)headers.Authorization='Bearer '+token;
    const opts={method,headers};if(body!==undefined)opts.body=JSON.stringify(body);
    const res=await fetch(API+path,opts);
    let result;const raw=await res.text();try{result=raw?JSON.parse(raw):null}catch{result=raw}
    if(!res.ok)throw Error(result?.message||result?.msg||result?.error_description||result?.error||'Erro HTTP '+res.status);
    return result;
  }
  async function validToken(){if(!session)return null;if((session.expires_at||0)*1000>Date.now()+60_000)return session.access_token;
    if(refreshPromise)return refreshPromise;
    refreshPromise=(async()=>{const resp=await request('POST','/auth/v1/token?grant_type=refresh_token',{refresh_token:session.refresh_token},false);setSession(resp);return session.access_token})().catch(err=>{cloudMessage='A sessão expirou; entre novamente. '+friendly(err);printBar();return null}).finally(()=>refreshPromise=null);
    return refreshPromise;
  }
  function setSession(info){const u=info.user||session?.user;if(!u?.id || !info.access_token || !info.refresh_token)throw Error('Resposta de autenticação incompleta');session={user:u,access_token:info.access_token,refresh_token:info.refresh_token,expires_at:info.expires_at||Math.floor(Date.now()/1000)+Number(info.expires_in||3600)};storage.set(sessionKey,JSON.stringify(session))}
  async function login(info){
    if(session && (dirty||isPending())){alert('Há alterações pendentes nesta conta. Faça o backup antes de trocar.');return}
    closeModal();setSession(info);epoch++;showEntry('loading');await loadAccount(epoch);
  }
  async function loadAccount(marker){
    if(!session)return;active=false;busy=false;blocked=false;cloudMessage='Carregando sua conta…';printBar();
    const id=session.user.id;
    let rows;try{rows=await request('GET','/rest/v1/user_states?user_id=eq.'+encodeURIComponent(id)+'&select=payload,revision');}catch(err){
      if(marker!==epoch)return;
      const cache=storage.get(userCacheKey(id));if(cache){key=userCacheKey(id);try{setLocal(JSON.parse(cache))}catch{state=fresh()}revision=Number(storage.get('meu_treino_v3_rev_'+id)||0);dirty=isPending();active=true;cloudMessage='Sem acesso à nuvem. Trabalhe localmente e sincronize depois.';printBar();return}
      session=null;storage.del(sessionKey);key=GUEST_KEY;state=hydrate(fresh());mode='entry';cloudMessage='Não foi possível abrir a conta: '+friendly(err);showEntry('choose',cloudMessage);printBar();return
    }
    if(marker!==epoch)return;
    key=userCacheKey(id);
    const row=rows?.[0];const cacheStr=storage.get(key);const pending=storage.get(pendingKey(id))==='1';
    if(row){
      revision=Number(row.revision)||0;
      const baseRev=Number(storage.get('meu_treino_v3_rev_'+id)||0);
      if(pending && cacheStr){
        if(baseRev===revision){setLocal(JSON.parse(cacheStr));dirty=true;active=true;cloudMessage='Alterações locais aguardando envio';printBar();syncSoon(0);return}
        setLocal(JSON.parse(cacheStr));dirty=true;active=true;blocked=true;cloudMessage='';printBar();conflictPanel();return;
      }
      setLocal(row.payload);storage.set('meu_treino_v3_rev_'+id,String(revision));dirty=false;clearPending();active=true;cloudMessage='';printBar();
    }else{
      revision=0;
      const existing=pending && cacheStr;
      setLocal(existing?JSON.parse(cacheStr):fresh());active=true;dirty=true;markPending();storage.set('meu_treino_v3_rev_'+id,'0');cloudMessage='Conta iniciada com fichas padrão';printBar();syncSoon(0);
    }
    if(getV2() && storage.get('meu_treino_v3_import_prompt_'+id)!=='1'){
      storage.set('meu_treino_v3_import_prompt_'+id,'1');migrationPanel();
    }
  }
  async function reloadFromCloud(){
    if(dirty||blocked){alert('Há alterações locais pendentes ou em conflito. Faça backup e resolva antes de atualizar a partir da nuvem.');return}
    const original=$('reloadCloud');if(original)original.disabled=true;
    try{const row=await getRemote();if(row && Number(row.revision)>revision){setLocal(row.payload);revision=Number(row.revision);storage.set('meu_treino_v3_rev_'+session.user.id,String(revision));clearPending();cloudMessage=''}
      closeModal();printBar();toast('Dados atualizados!');
    }catch(err){alert('Não foi possível atualizar: '+friendly(err))}finally{if(original?.isConnected)original.disabled=false}
  }
  function deleteAccountPanel(){
    if(!session){accountPanel();return}
    const hasPending=dirty||busy||blocked||isPending();
    modal(`<div class="flex"><h2>Excluir minha conta</h2><button id="closeCloud" class="btn secondary sm">✕</button></div>
      <div class="cloudnotice error"><b>Esta operação é irreversível.</b> A conta de <b>${safe(session.user.email||'')}</b> e seus treinos, cargas, corridas e pesagens serão removidos do banco ativo do Meu Treino. Dados já exportados e cópias locais de outros dispositivos não são removidos remotamente. Logs e backups dos provedores seguem seus prazos próprios.</div>
      ${hasPending?'<div class="cloudnotice error">Existem alterações locais pendentes ou um conflito de sincronização. Baixe seu backup antes de continuar: os registros ainda não sincronizados também serão descartados neste aparelho.</div>':''}
      <div class="stack" style="margin-top:12px">
        <button class="btn secondary" id="deleteBackup">1. Baixar backup dos meus dados</button>
        <div><label for="deletePhrase">2. Para confirmar, digite EXCLUIR</label><input id="deletePhrase" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="EXCLUIR"></div>
        <label style="display:flex;gap:8px;align-items:flex-start;font-size:13px"><input type="checkbox" id="deleteAck" style="width:20px;min-width:20px;margin-top:3px"><span>Entendo que perderei acesso a esta conta e que a operação não pode ser desfeita.</span></label>
        <button class="btn danger full" id="deleteConfirm" disabled>Excluir definitivamente</button>
        <button class="btn secondary full" id="deleteCancel">Cancelar e manter minha conta</button>
      </div><p class="small" role="status" id="deleteResult"></p>`);
    $('deleteBackup').onclick=saveAllBackup;
    const approve=()=>{$('deleteConfirm').disabled=deleting||$('deletePhrase').value.trim()!=='EXCLUIR'||!$('deleteAck').checked};
    $('deletePhrase').addEventListener('input',approve);$('deleteAck').addEventListener('change',approve);
    $('deleteCancel').onclick=closeModal;
    $('deleteConfirm').onclick=deleteAccount;
  }
  async function deleteAccount(){
    if(deleting||!session)return;
    const button=$('deleteConfirm'),status=$('deleteResult');
    if(!button||button.disabled||$('deletePhrase')?.value.trim()!=='EXCLUIR'||!$('deleteAck')?.checked)return;
    deleting=true;button.disabled=true;button.textContent='Excluindo sua conta…';msg(status,'Validando a sessão e excluindo os dados. Aguarde.');
    clearTimeout(syncTimer);
    const accountId=session.user.id;
    try{
      // Nunca envia user_id fornecido pelo navegador: o servidor obtém a conta a partir do token validado.
      const response=await request('POST','/functions/v1/delete-account',{confirmation:'EXCLUIR'});
      if(response?.deleted!==true)throw Error('Não foi possível confirmar a exclusão no servidor.');
      // A exclusão no banco foi confirmada; só agora limpamos as cópias desta conta neste aparelho.
      epoch++;active=false;busy=false;blocked=false;dirty=false;revision=0;
      session=null;storage.del(sessionKey);
      storage.del(userCacheKey(accountId));
      storage.del(pendingKey(accountId));
      storage.del('meu_treino_v3_rev_'+accountId);
      storage.del('meu_treino_v3_import_prompt_'+accountId);
      key=GUEST_KEY;mode='entry';
      state=hydrate(fresh());selected='A';
      showEntry('choose');
      cloudMessage='Sua conta foi excluída. Os dados locais deste usuário foram removidos deste aparelho.';
      closeModal();showPage('inicio');printBar();
      alert('Conta excluída com sucesso. Caso tenha usado o aplicativo em outros aparelhos, limpe os dados locais neles também.');
      location.reload();
    }catch(err){
      deleting=false;msg(status,'A exclusão não foi confirmada. Seus dados foram mantidos. Detalhe: '+friendly(err));
      if(button?.isConnected){button.textContent='Tentar excluir novamente';button.disabled=false;}
      printBar();
    }
  }
  async function logout(){
    if(dirty||isPending()){if(!confirm('Existem dados ainda não sincronizados. Exporte um backup antes de sair. Deseja continuar?'))return}
    clearTimeout(syncTimer);const tok=session?.access_token;epoch++;session=null;storage.del(sessionKey);active=false;blocked=false;dirty=false;revision=0;cloudMessage='';
    key=GUEST_KEY;mode='entry';state=hydrate(fresh());selected='A';closeModal();showEntry('choose');printBar();
    if(tok){fetch(API+'/auth/v1/logout',{method:'POST',headers:{apikey:CONF.anonKey,Authorization:'Bearer '+tok}}).catch(()=>{})}
  }
  window.__mt3SaveHook=()=>{
    if(!active||!session||blocked||deleting)return;
    dirty=true;markPending();printBar();syncSoon(750);
  };
  function syncSoon(delay=800){if(!session||!active||blocked||deleting||!configured)return;clearTimeout(syncTimer);syncTimer=setTimeout(()=>syncNow(epoch),delay)}
  async function syncNow(marker){if(!session||!dirty||!active||blocked||busy||deleting||!navigator.onLine)return;
    busy=true;printBar();const data=snapshot(),baseRevision=revision,accountId=session.user.id;
    try{const next=await request('POST','/rest/v1/rpc/save_my_state',{p_expected_revision:baseRevision,p_payload:data});
      if(marker!==epoch||session?.user.id!==accountId)return;
      if(!Number.isInteger(Number(next))||Number(next)<1)throw Error('Revisão inesperada');
      revision=Number(next);storage.set('meu_treino_v3_rev_'+accountId,String(revision));
      // Changes may have occurred while request was in flight.
      if(JSON.stringify(data)===JSON.stringify(state)){dirty=false;clearPending()}else{dirty=true;markPending()}
      cloudMessage='';
    }catch(err){if(marker!==epoch)return;const message=friendly(err);
      if(/VERSION_CONFLICT|conflict|revision|23505/i.test(message)){blocked=true;cloudMessage='';conflictPanel()}else cloudMessage='Nuvem indisponível: '+message;
    }finally{if(marker===epoch){busy=false;printBar();if(dirty&&!blocked&&navigator.onLine)syncSoon(cloudMessage?15000:500)}}
  }
  async function getRemote(){const rows=await request('GET','/rest/v1/user_states?user_id=eq.'+encodeURIComponent(session.user.id)+'&select=payload,revision');return rows?.[0]||null}
  function conflictPanel(){
    modal(`<div class="flex"><h2>Conflito de sincronização</h2><button id="closeCloud" class="btn secondary sm">✕</button></div><p>Outra alteração foi salva na nuvem antes da sua. Para evitar perda, pausamos o envio. Seus dados locais continuam aqui.</p><p class="small muted">Escolha conscientemente qual versão deseja manter. Primeiro baixe um backup.</p><div class="stack"><button class="btn" id="confBackup">1. Baixar backup desta versão local</button><button class="btn secondary" id="confRemote">2. Carregar versão da nuvem</button><button class="btn danger" id="confLocal">3. Substituir versão da nuvem pelos meus dados locais</button></div><p id="confResult" class="muted small"></p>`);
    $('confBackup').onclick=saveAllBackup;
    $('confRemote').onclick=async()=>{if(!confirm('Substituir a versão LOCAL pela versão da NUVEM? Exporte backup antes.'))return;try{const r=await getRemote();if(!r)throw Error('Sem registro remoto');setLocal(r.payload);revision=Number(r.revision);storage.set('meu_treino_v3_rev_'+session.user.id,String(revision));blocked=false;dirty=false;clearPending();cloudMessage='';closeModal();printBar()}catch(e){msg($('confResult'),friendly(e))}};
    $('confLocal').onclick=async()=>{if(!confirm('ATENÇÃO: isso substituirá os dados da nuvem pelos dados deste aparelho. Você já exportou os dois backups necessários?'))return;try{const r=await getRemote();revision=Number(r?.revision||0);storage.set('meu_treino_v3_rev_'+session.user.id,String(revision));blocked=false;dirty=true;markPending();closeModal();syncSoon(0)}catch(e){msg($('confResult'),friendly(e))}};
  }
  function fingerprint(s){const base=JSON.stringify(s);let h=2166136261;for(let i=0;i<base.length;i++)h=Math.imul(h^base.charCodeAt(i),16777619);return 'v2-'+(h>>>0).toString(16)}
  function mergeById(current,legacy,prefix){const seen=new Set(current.map((it,i)=>String(it.id||prefix+fingerprint(it))));const out=[...current];for(const it of legacy){const id=String(it.id||prefix+fingerprint(it));if(seen.has(id))continue;seen.add(id);out.push({...it,id})}return out}
  function mergeV2(legacy){
    const result=snapshot();result.migrations??=[];
    const tag=fingerprint(legacy);
    if(result.migrations.includes(tag))return null;
    result.logs=mergeById(result.logs,legacy.logs,'log-').sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
    result.runLogs=mergeById(result.runLogs,legacy.runLogs,'run-').sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
    result.weights=mergeById(result.weights,legacy.weights,'weight-').sort((a,b)=>String(a.date||'').localeCompare(String(b.date||'')));
    const oldW=legacy.workouts||{};
    // Em conta nova ainda com fichas padrao, substituir o template pelas fichas V2
    // evita criar Treino A (importado) desnecessariamente.
    const pristine=!(state.logs?.length||state.runLogs?.length||state.weights?.length||state.migrations?.length)
      && Object.keys(state.workouts||{}).length===Object.keys(DEFAULT).length
      && Object.entries(DEFAULT).every(([id,w])=>state.workouts[id]?.name===w.name);
    if(pristine){result.workouts=clone(oldW);result.runWeek=legacy.runWeek||1;result.restSeconds=legacy.restSeconds||90;}
    else for(const [k,w] of Object.entries(oldW)){
      if(!result.workouts[k]){result.workouts[k]=w;continue}
      if(JSON.stringify(result.workouts[k])===JSON.stringify(w))continue;
      const exists=Object.values(result.workouts).some(a=>JSON.stringify(a)===JSON.stringify(w));
      if(!exists){let candidate='v2-'+k,n=1;while(result.workouts[candidate])candidate='v2-'+k+'-'+(++n);result.workouts[candidate]={...w,name:w.name+' (importado V2)'}}
    }
    result.migrations.push(tag);
    return result;
  }
  function migrationPanel(){const legacy=getV2();if(!legacy){toast('Nenhum histórico da versão 2.0 encontrado neste navegador.');closeModal();return}
    const already=(state.migrations||[]).includes(fingerprint(legacy));
    modal(`<div class="flex"><h2>Importar dados da V2</h2><button class="btn secondary sm" id="closeCloud">✕</button></div><p>Encontramos dados da versão anterior neste navegador:</p><div class="card"><b>${safe(summarize(legacy))}</b></div><p>Os registros e as fichas personalizadas serão <b>somados</b> aos dados desta conta; duplicatas identificadas serão ignoradas. Sua V2 não será modificada ou apagada.</p>${already?'<p class="muted">Esta cópia já foi importada.</p>':''}<div class="stack"><button class="btn secondary" id="legacyBackup">Exportar backup da V2</button><button class="btn secondary" id="accountBackup">Exportar backup da conta atual</button><button class="btn" id="confirmMigration" ${already?'disabled':''}>Confirmar importação para esta conta</button></div><p id="migrationResult" class="small muted"></p>`);
    $('legacyBackup').onclick=()=>download(legacy,'meu-treino-v2-backup-'+today()+'.json');
    $('accountBackup').onclick=saveAllBackup;
    $('confirmMigration').onclick=()=>{if(blocked){msg($('migrationResult'),'Resolva primeiro o conflito da nuvem.');return}if(!confirm('Você fez backup? Importar fichas e histórico da V2 para sua conta?'))return;try{const result=mergeV2(legacy);if(!result){msg($('migrationResult'),'Essa cópia já foi importada.');return}state=hydrate(result);save();closeModal();showPage('inicio');toast('Dados da V2 importados!');syncSoon(0)}catch(e){msg($('migrationResult'),friendly(e))}}
  }
  function resetPasswordPanel(){modal(`<div class="flex"><h2>Redefinir senha</h2><button class="btn secondary sm" id="closeCloud">Fechar</button></div><p>Enviaremos para seu e-mail um link de redefinição de senha.</p><button id="sendRecover" class="btn full">Enviar link para ${safe(session.user.email)}</button><p id="recoverResult" class="muted small"></p>`);$('sendRecover').onclick=async()=>{try{await request('POST','/auth/v1/recover?redirect_to='+encodeURIComponent(location.origin+location.pathname),{email:session.user.email},false);msg($('recoverResult'),'Confira sua caixa de entrada e spam.')}catch(e){msg($('recoverResult'),friendly(e))}}}
  async function callbackFromEmail(){const hash=new URLSearchParams(location.hash.slice(1));const type=hash.get('type');if(hash.get('access_token') && hash.get('refresh_token')){
    const tokens={access_token:hash.get('access_token'),refresh_token:hash.get('refresh_token'),expires_in:Number(hash.get('expires_in')||3600)};
    window.history.replaceState(null,'',location.pathname+location.search);
    try{const me=await requestWithToken('GET','/auth/v1/user',tokens.access_token);tokens.user=me;await login(tokens);if(type==='recovery')passwordEditor()}catch(e){cloudMessage='Falha ao confirmar o link: '+friendly(e);showEntry('choose',cloudMessage);printBar()}return true}
    if(location.search.includes('code=') || type==='signup'){
      // Supabase default can redirect with a PKCE code; explicit support requires verifier absent in static client.
      cloudMessage='Link recebido. Se sua conta foi confirmada, entre com e-mail e senha.';printBar();
    }
    return false;
  }
  async function requestWithToken(method,path,token,body){const opts={method,headers:{apikey:CONF.anonKey,Authorization:'Bearer '+token,'Content-Type':'application/json'}};if(body)opts.body=JSON.stringify(body);const r=await fetch(API+path,opts),obj=await r.json();if(!r.ok)throw Error(obj.message||obj.msg||'Erro de autenticação');return obj}
  function passwordEditor(){modal(`<div class="flex"><h2>Criar nova senha</h2><button class="btn secondary sm" id="closeCloud">Fechar</button></div><label>Nova senha (mínimo 8 caracteres)</label><input id="newPwd" type="password" minlength="8" autocomplete="new-password"><button class="btn full" style="margin-top:10px" id="updatePwd">Atualizar senha</button><p id="pwdResult" class="muted small"></p>`);$('updatePwd').onclick=async()=>{const p=$('newPwd').value;if(p.length<8){msg($('pwdResult'),'Use no mínimo 8 caracteres.');return}try{await request('PUT','/auth/v1/user',{password:p});msg($('pwdResult'),'Senha atualizada! Você já pode continuar treinando.')}catch(e){msg($('pwdResult'),friendly(e))}}}
  async function startup(){showEntry('loading');printBar();window.addEventListener('online',()=>{cloudMessage='';printBar();syncSoon(0)});window.addEventListener('offline',printBar);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)syncSoon(0)});
    if(!configured){cloudMessage='Versão beta local: configure Supabase para ativar contas e nuvem.';showEntry('choose');printBar();return}
    if(await callbackFromEmail())return;
    let stored;try{stored=JSON.parse(storage.get(sessionKey))}catch{};
    if(stored?.access_token && stored?.refresh_token && stored?.user?.id){session=stored;epoch++;await loadAccount(epoch)}else {showEntry('choose',cloudMessage);printBar()}
  }
  startup().catch(e=>{cloudMessage='Falha na inicialização da conta: '+friendly(e);showEntry('choose',cloudMessage);printBar()});
  // API de teste com mocks; nenhuma informação confidencial é exposta por isto.
  window.MeuTreino3={getStatus:()=>({configured,mode:session?'user':mode,dirty,revision,blocked}),showLogin:accountPanel,backup:saveAllBackup};
})();
