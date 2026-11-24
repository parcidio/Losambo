'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $('#view');
let ME = null;
let cleanups = [];

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function api(method, path, body) {
  const res = await fetch(`/console-api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/entrar';
    throw new Error('Sessão expirada');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.issues ? ` (${data.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ')})` : '';
    throw new Error((data.message || `Erro ${res.status}`) + detail);
  }
  return data;
}

function toast(msg, bad = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.setAttribute('role', bad ? 'alert' : 'status');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), bad ? 6000 : 3000);
}

async function busy(btn, fn) {
  btn.disabled = true;
  try {
    return await fn();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

function every(ms, fn) {
  const id = setInterval(fn, ms);
  cleanups.push(() => clearInterval(id));
}

function fmtPhone(p) {
  if (!p) return '—';
  const d = String(p).replace(/\D/g, '');
  if (d.startsWith('244') && d.length === 12) return `+244 ${d.slice(3, 6)} ${d.slice(6, 9)} ${d.slice(9)}`;
  return '+' + d;
}

function ago(ts) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'ontem' : `há ${d} dias`;
}

function dt(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('pt-PT', { dateStyle: 'medium', timeStyle: 'short' });
}

const STATUS = {
  WORKING: ['ok', 'Ligado'],
  SCAN_QR_CODE: ['warn', 'Ler QR'],
  PASSKEY_REQUIRED: ['info', 'Confirmar no telemóvel'],
  PASSKEY_CONFIRMATION_REQUIRED: ['info', 'Confirmar no telemóvel'],
  STARTING: ['info', 'A iniciar'],
  STOPPED: ['mute', 'Parado'],
  FAILED: ['bad', 'Falhou'],
};
function statusPill(s) {
  const [cls, label] = STATUS[s] || ['mute', s];
  return `<span class="pill ${cls}"><i></i>${esc(label)}</span>`;
}

const CAPPING = { NONE: 'Normal', FIRST_WARNING: '1.º aviso', SECOND_WARNING: '2.º aviso', CAPPED: 'Limitado' };
function cappingPill(c) {
  if (!c) return '—';
  const cls = c === 'NONE' ? 'ok' : c === 'CAPPED' ? 'bad' : 'warn';
  return `<span class="pill ${cls}">${esc(CAPPING[c] || c)}</span>`;
}

const PERM_LABEL = { read: 'ler', send: 'enviar', control: 'controlar', settings: 'definições', delete: 'apagar' };
const EVENT_LABEL = {
  message: 'Mensagem recebida',
  'session.status': 'Estado do número',
  'message.ack': 'Entregue / lida',
  'message.reaction': 'Reação',
  'call.received': 'Chamada recebida',
  'otp.verified': 'OTP verificado',
  'number.capping': 'Aviso de quota',
};

const icon = {
  chev: '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="#6B6F73" stroke-width="2"><path d="M9 6l6 6-6 6"></path></svg>',
  plus: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5v14M5 12h14"></path></svg>',
  clock: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="#6B6F73" stroke-width="1.8"><path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4M12 8v4l3 2"></path></svg>',
  search: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="#6B6F73" stroke-width="2"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-4-4"></path></svg>',
};

// Início

async function viewInicio() {
  view.innerHTML = `<main class="wide"><p class="lead">A carregar…</p></main>`;
  const o = await api('GET', '/overview');
  const recent = JSON.parse(localStorage.getItem('lsb_recent') || '[]').slice(0, 4);
  const nums = o.numbers.slice(0, 4);
  view.innerHTML = `<main class="wide">
  <div style="text-align:center">
    ${o.numbers.length || !ME.tenant.limits.allowOwnNumbers ? '' : `<a class="home-cta" href="#/numeros/ligar">Ligue o seu primeiro número em 2 minutos <span><svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="#1D1F20" stroke-width="2.4"><path d="M5 12h13M12 6l6 6-6 6"></path></svg></span></a>`}
    <h1 class="home-h1" style="margin:48px 0 40px;font-size:46px;font-weight:600;letter-spacing:-.02em">Pronto quando estiver.</h1>
  </div>
  ${o.waha ? '' : ME.user.is_admin
    ? `<p class="note bad">O motor WAHA não está a responder. Veja os registos do serviço <code>waha</code> e se <code>WAHA_API_KEY</code> é o mesmo nos dois serviços.${o.waha_error ? `<br><span style="font-size:13px">Erro: <code>${esc(o.waha_error)}</code></span>` : ''}</p>`
    : '<p class="note bad">O envio de WhatsApp está temporariamente indisponível. A equipa Losambo já foi avisada.</p>'}
  <form class="bigsearch" id="bigsearch" role="search">
    <label for="big" class="sr">Pesquisar</label>
    <div class="searchbox">${icon.search}<input id="big" type="search" placeholder="Pesquisar números, mensagens, OTP…"><kbd>Ctrl</kbd><kbd>K</kbd></div>
  </form>
  <div class="cols">
    <section aria-labelledby="c1">
      <h2 id="c1"><a href="#/numeros">Números ›</a></h2>
      ${nums.length ? nums.map((n) => `<a class="li" href="#/numeros/${n.id}">
        <span class="dot" style="background:${n.status === 'WORKING' ? '#12A150' : n.status === 'FAILED' ? '#B42318' : '#F6821F'}"></span>
        <span class="mono" style="flex:1;font-size:15px">${esc(n.phone ? fmtPhone(n.phone) : n.session_name)}</span>
        <span style="font-size:14px;color:${n.status === 'WORKING' ? '#0B6B3A' : '#9A4A06'}">${esc((STATUS[n.status] || [, n.status])[1])}</span>${icon.chev}</a>`).join('')
        : ME.tenant.limits.allowOwnNumbers ? `<a class="ghost" href="#/numeros/ligar">${icon.plus}Ligar número</a>` : `<p class="lead">Ainda sem números. A Losambo atribui-lhe um número quando a subscrição é ativada.</p>`}
    </section>
    <section aria-labelledby="c2">
      <h2 id="c2"><a href="#/webhooks">Webhooks ›</a></h2>
      ${o.webhook ? `<a class="li" href="#/webhooks"><span class="dot" style="background:#12A150"></span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(o.webhook.url)}</span><span style="font-size:14px;color:#4E5255">${o.webhook.events.length} eventos</span>${icon.chev}</a>`
        : `<a class="ghost" href="#/webhooks">${icon.plus}Ligar o seu servidor</a>`}
      <div class="kpis" style="margin-top:20px">
        <div class="kpi"><p>OTP nas últimas 24 h</p><p>${o.otp?.day ?? 0} · ${o.otp?.verified ?? 0} verificados</p></div>
        <div class="kpi"><p>Mensagens este mês</p><p>${o.messages?.month ?? 0}${ME.tenant.limits.monthlyMessages ? ' / ' + ME.tenant.limits.monthlyMessages : ''}</p></div>
      </div>
    </section>
    <section aria-labelledby="c3">
      <h2 id="c3">Recentes</h2>
      ${recent.length ? recent.map((r) => `<a class="li" href="${esc(r.href)}">${icon.clock}<span style="flex:1"><span style="color:#6B6F73">${esc(r.group)} /</span> ${esc(r.label)}</span>${icon.chev}</a>`).join('')
        : `<p class="lead">Ainda nada por aqui.</p>`}
    </section>
  </div></main>`;
  $('#bigsearch').addEventListener('submit', (e) => {
    e.preventDefault();
    location.hash = `#/pesquisa/${encodeURIComponent($('#big').value)}`;
  });
}

function remember(group, label, href) {
  const list = JSON.parse(localStorage.getItem('lsb_recent') || '[]').filter((r) => r.href !== href);
  list.unshift({ group, label, href });
  localStorage.setItem('lsb_recent', JSON.stringify(list.slice(0, 8)));
}

// Números

function typeChip(n) {
  return n.ownership === 'platform' ? '<span class="chip" title="Número fornecido pela Losambo">Losambo</span>' : '<span class="chip" title="Número próprio da conta">Próprio</span>';
}

function rowAction(n) {
  if (n.ownership === 'platform') return ['Ver', `#/numeros/${n.id}`];
  if (n.status === 'WORKING') return ['Ver', `#/numeros/${n.id}`];
  if (n.status === 'SCAN_QR_CODE' || n.status === 'STARTING') return ['Religar', `#/numeros/ligar/${n.id}`];
  if (n.status.startsWith('PASSKEY')) return ['Ver código', `#/numeros/ligar/${n.id}`];
  if (n.status === 'FAILED') return ['Reiniciar', `#/numeros/${n.id}`];
  return ['Iniciar', `#/numeros/${n.id}`];
}

async function viewNumeros(selectedId) {
  view.innerHTML = `<main><p class="lead">A carregar…</p></main>`;
  const numbers = await api('GET', '/numbers');
  const sel = numbers.find((n) => String(n.id) === String(selectedId)) || numbers.find((n) => n.status === 'WORKING') || numbers[0];
  view.innerHTML = `<main>
  <div class="head"><div><h1 class="page">Números</h1><p class="lead">${ME.tenant.limits.allowOwnNumbers ? 'Números Losambo atribuídos à conta e os seus números próprios.' : 'Os números WhatsApp que a Losambo atribuiu à sua conta.'}</p></div>
  ${ME.tenant.limits.allowOwnNumbers ? '<a class="btn" href="#/numeros/ligar">+ Ligar o meu número</a>' : '<a class="btn sec" href="#/numeros/ligar">Usar o meu próprio número</a>'}</div>
  <div class="tablebox"><table style="min-width:760px">
    <thead><tr><th>Número</th><th>Tipo</th><th>Sessão</th><th>Estado</th><th>Quota de novas conversas</th><th>Última atividade</th><th><span class="sr">Ações</span></th></tr></thead>
    <tbody>${numbers.length ? numbers.map((n) => {
      const [label, href] = rowAction(n);
      return `<tr class="${sel && n.id === sel.id ? 'sel' : ''}"><td class="mono">${esc(fmtPhone(n.phone))}</td><td>${typeChip(n)}</td><td><code>${esc(n.session_name)}</code></td>
      <td>${statusPill(n.status)}</td><td>${cappingPill(n.capping_status)}</td><td>${esc(ago(n.last_activity))}</td>
      <td style="text-align:right"><a href="${href}" style="font-weight:500">${label}</a></td></tr>`;
    }).join('') : `<tr><td colspan="7" class="empty">${ME.tenant.limits.allowOwnNumbers ? 'Ainda não há números. <a href="#/numeros/ligar">Ligar o meu número</a>.' : 'Ainda não há números atribuídos à conta. A equipa Losambo atribui o número quando a subscrição é ativada.'}</td></tr>`}</tbody>
  </table></div>
  <div id="detail"></div></main>`;
  if (sel) renderDetail(sel.id);
}

async function renderDetail(id) {
  const box = $('#detail');
  box.innerHTML = `<p class="lead">A ler a saúde do número…</p>`;
  let h;
  try {
    h = await api('GET', `/numbers/${id}/health`);
  } catch (err) {
    box.innerHTML = `<p class="note bad">${esc(err.message)}</p>`;
    return;
  }
  const n = h.number;
  remember('Números', n.session_name, `#/numeros/${n.id}`);
  const c = h.capping;
  const unlimited = c && c.totalQuota < 0;
  const pct = c && !unlimited && c.totalQuota > 0 ? Math.min(100, Math.round((c.usedQuota / c.totalQuota) * 100)) : 0;
  const cycle = c && c.cycleStart ? `${new Date(c.cycleStart * (c.cycleStart < 1e12 ? 1000 : 1)).toLocaleDateString('pt-PT')} → ${c.cycleEnd ? new Date(c.cycleEnd * (c.cycleEnd < 1e12 ? 1000 : 1)).toLocaleDateString('pt-PT') : '—'}` : '—';
  const tl = h.timelock;
  const ep = await api('GET', '/webhook').catch(() => null);
  const working = n.status === 'WORKING';
  const platform = n.ownership === 'platform';
  box.innerHTML = `
  <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px">
    <h2 style="margin:0;font-size:22px;font-weight:600">${esc(n.session_name)} <span style="font-weight:400;color:#4E5255;font-size:16px">· ${esc(fmtPhone(n.phone))}</span> ${typeChip(n)}</h2>
    ${platform ? '<p class="lead" style="margin:0">Número Losambo dedicado a esta conta — ligação e ritmo geridos pela equipa Losambo.</p>' : `<div class="btns">
      ${n.status === 'STOPPED' || n.status === 'FAILED' ? `<button type="button" class="btn sec" data-act="start">Iniciar</button>` : ''}
      ${n.status === 'SCAN_QR_CODE' ? `<a class="btn sec" href="#/numeros/ligar/${n.id}">Ler QR</a>` : ''}
      <button type="button" class="btn sec" data-act="restart">Reiniciar</button>
      ${n.status !== 'STOPPED' ? `<button type="button" class="btn sec" data-act="stop">Parar</button>` : ''}
      <button type="button" class="btn danger" data-act="logout">Terminar sessão</button>
      <button type="button" class="btn danger" data-act="delete">Apagar</button>
    </div>`}
  </div>
  <div class="grid2">
    <section class="card" aria-labelledby="h-saude">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:4px">
        <h3 id="h-saude" style="margin:0">Saúde do número</h3><span class="mono" style="font-size:12px;color:#4E5255">GET /sessions/{s}/capping</span>
      </div>
      <p style="margin:0 0 22px;font-size:14px;color:#4E5255;line-height:1.55">O WhatsApp limita quantas conversas <strong style="color:#1D1F20">novas</strong> cada número pode abrir por ciclo. Responder em conversas já abertas não conta.</p>
      ${!working ? `<p class="note warn">O número não está ligado (${esc((STATUS[n.status] || [, n.status])[1])}). A quota só pode ser lida com a sessão em WORKING.</p>` : !c ? `<p class="note warn">Este motor não devolveu a quota. ${esc(h.errors.join(' · '))}</p>` : `
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
        <span style="font-size:15px;font-weight:500">Novas conversas neste ciclo</span>
        <span class="mono" style="font-size:15px">${unlimited ? 'sem limite' : `${c.usedQuota} / ${c.totalQuota}`}</span>
      </div>
      <div class="bar" role="img" aria-label="${pct}% da quota usada"><div style="width:${pct}%"></div></div>
      <div style="display:flex;justify-content:space-between;font-size:13px;color:#4E5255;margin-bottom:22px"><span>Ciclo: ${esc(cycle)}</span><span>${unlimited ? '' : pct + '% usado'}</span></div>
      <div class="scale" aria-label="Escala de aviso">
        ${['NONE', 'FIRST_WARNING', 'SECOND_WARNING', 'CAPPED'].map((k) => `<div class="${c.cappingStatus === k ? 'on' : ''}">${CAPPING[k]}</div>`).join('')}
      </div>`}
      <div class="kpis">
        <div class="kpi"><p>Bloqueio temporário</p><p style="color:${tl?.isActive ? '#A11D12' : '#0B6B3A'}">${tl ? (tl.isActive ? `Ativo${tl.timeEnforcementEnds ? ' até ' + dt(tl.timeEnforcementEnds * (tl.timeEnforcementEnds < 1e12 ? 1000 : 1)) : ''}` : 'Nenhum') : '—'}</p></div>
        <div class="kpi"><p>Ação automática</p><p>${c && c.cappingStatus === 'CAPPED' ? 'OTP usa verificação inversa (fallback)' : 'OTP muda para verificação inversa'}</p></div>
      </div>
    </section>
    <section class="card" aria-labelledby="h-det">
      <h3 id="h-det">Detalhes</h3>
      <dl class="det">
        <dt>Nome no WhatsApp</dt><dd>${esc(n.me_name || '—')}</dd>
        <dt>Estado</dt><dd>${statusPill(n.status)}</dd>
        <dt>Motor</dt><dd>${n.engine ? `<code>${esc(n.engine)}</code>` : '—'}</dd>
        <dt>Worker</dt><dd>${n.worker ? `<code>${esc(n.worker)}</code>` : '—'}</dd>
        <dt>Ligado desde</dt><dd>${esc(dt(n.connected_since))}</dd>
        <dt>Webhooks</dt><dd>${ep?.endpoint ? `${ep.endpoint.events.length} eventos · ` : 'nenhum · '}<a href="#/webhooks">editar</a></dd>
      </dl>
      <div class="sep"></div>
      <h4 style="margin:0 0 12px;font-size:15px">Ritmo de envio</h4>
      ${platform ? `<p class="lead">Máximo ${n.max_per_minute} mensagens por minuto${n.typing ? ', com “a escrever…”' : ''}. Partilhado com outras contas.</p>` : ''}
      <form id="pacing" ${platform ? 'hidden' : ''}>
        <label class="row"><span>Mostrar “a escrever…” antes de enviar</span><input type="checkbox" name="typing" ${n.typing ? 'checked' : ''}></label>
        <label class="row"><span>Marcar como lida ao responder</span><input type="checkbox" name="mark_read" ${n.mark_read ? 'checked' : ''}></label>
        <label for="rpm" style="display:block;font-size:14px;padding:8px 0 6px">Máximo por minuto</label>
        <input id="rpm" class="in" name="max_per_minute" type="number" min="1" max="60" value="${n.max_per_minute}">
        <button type="submit" class="btn sec" style="margin-top:12px">Guardar ritmo</button>
      </form>
    </section>
  </div>`;
  $$('[data-act]', box).forEach((b) =>
    b.addEventListener('click', () =>
      busy(b, async () => {
        const act = b.dataset.act;
        if (act === 'delete') {
          if (!confirm(`Apagar ${n.session_name}? O número é desassociado e a sessão removida do WAHA.`)) return;
          await api('DELETE', `/numbers/${n.id}`);
          toast('Número apagado');
          return viewNumeros();
        }
        if (act === 'logout' && !confirm('Terminar a sessão? Terá de ler o QR outra vez.')) return;
        await api('POST', `/numbers/${n.id}/${act}`);
        toast('Pedido enviado ao WAHA');
        setTimeout(() => viewNumeros(n.id), 1200);
      }),
    ),
  );
  if (!platform) $('#pacing').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    busy(f.querySelector('button'), async () => {
      await api('PATCH', `/numbers/${n.id}`, {
        typing: f.typing.checked,
        mark_read: f.mark_read.checked,
        max_per_minute: Number(f.max_per_minute.value),
      });
      toast('Ritmo guardado');
    });
  });
}

// Ligar número

async function viewLigar(id, admin = false) {
  // admin = ligar um número Losambo (da plataforma) com a chave admin
  const base = admin ? '/admin/platform-numbers' : '/numbers';
  const listHref = admin ? '#/admin-numeros' : '#/numeros';
  const ligarHref = admin ? '#/admin-numeros/ligar' : '#/numeros/ligar';
  if (!id && !admin && !ME.tenant.limits.allowOwnNumbers) {
    view.innerHTML = `<main><div class="head"><div><h1 class="page">Usar o meu próprio número</h1><p class="lead">No plano ${esc(ME.tenant.plan_label)} a conta envia pelos números Losambo que lhe atribuímos.</p></div><a class="btn sec" href="#/numeros">Voltar a Números</a></div>
    <div class="grid2"><section class="card"><h2>Disponível no plano Negócio</h2>
      <p class="lead" style="margin-bottom:16px">Com o plano Negócio pode ligar os números WhatsApp da sua empresa (por QR ou código), e as mensagens saem com o seu nome e número.</p>
      <ul class="steps"><li>Números próprios ilimitados</li><li>Controlo da sessão: ligar, parar, religar</li><li>Ritmo de envio configurável por número</li></ul>
      <a class="btn" href="mailto:[EMAIL DE CONTACTO]?subject=Plano%20Neg%C3%B3cio">Falar connosco</a></section>
    <section class="card"><h2>O seu plano</h2><p class="lead">${esc(ME.tenant.plan_label)} · número Losambo dedicado</p></section></div></main>`;
    return;
  }
  if (!id) {
    view.innerHTML = `<main><div class="head"><div><h1 class="page">Ligar número</h1><p class="lead">O seu WhatsApp continua no telemóvel. O Losambo entra como um dispositivo associado, tal como o WhatsApp Web.</p></div></div>
    <div class="grid2"><section class="card">
      <h2>Antes de começar</h2>
      <p class="note warn"><strong>Use um número dedicado se puder.</strong> O Losambo não é a API oficial: se o número for bloqueado, o bloqueio afeta todo o WhatsApp desse número.</p>
      <ol class="steps"><li>Criamos uma sessão no motor WAHA.</li><li>Leia o QR com o telemóvel, ou use um código de 8 caracteres.</li><li>Mantenha o telemóvel ligado à internet — dispositivos associados desligam se ficar muito tempo offline.</li></ol>
      <button type="button" class="btn" id="create">Criar sessão e mostrar QR</button>
    </section>
    <section class="card"><h2>Plano</h2><p class="lead">${esc(ME.tenant.plan_label)} · ${ME.tenant.limits.maxNumbers == null ? 'números ilimitados' : ME.tenant.limits.maxNumbers + ' número(s)'}</p></section></div></main>`;
    $('#create').addEventListener('click', (e) =>
      busy(e.currentTarget, async () => {
        const n = await api('POST', base);
        location.hash = `${ligarHref}/${n.id}`;
      }),
    );
    return;
  }
  view.innerHTML = `<main><div class="head"><div><h1 class="page">Ligar número</h1><p class="lead" id="lg-sub">A preparar a sessão…</p></div><a class="btn sec" href="${listHref}">Voltar a Números</a></div>
  <div class="grid2"><section class="card" id="lg-main"></section>
  <section class="card"><h2>No telemóvel</h2><ol class="steps"><li>Abra o WhatsApp</li><li>Toque em <strong>⋮ / Definições › Dispositivos associados</strong></li><li><strong>Associar um dispositivo</strong> e aponte a câmara ao QR</li><li>Ou escolha <em>Associar com número de telefone</em> e escreva o código</li></ol></section></div></main>`;
  let tab = 'qr';
  let last = '';
  async function tick() {
    let numbers;
    try {
      numbers = await api('GET', base);
    } catch {
      return;
    }
    const n = numbers.find((x) => String(x.id) === String(id));
    if (!n) {
      $('#lg-main').innerHTML = `<p class="note bad">Número não encontrado.</p>`;
      return;
    }
    $('#lg-sub').innerHTML = `Sessão <code>${esc(n.session_name)}</code> · ${statusPill(n.status)}`;
    const key = n.status + tab;
    if (n.status === 'WORKING') {
      if (last !== key) {
        $('#lg-main').innerHTML = `<h2>Ligado ✓</h2><p class="note ok">${esc(fmtPhone(n.phone))} ${n.me_name ? '· ' + esc(n.me_name) : ''} está associado e pronto a enviar.</p>
        ${admin ? `<div class="btns"><a class="btn" href="#/admin-numeros">Ver números Losambo</a></div>` : `<div class="btns"><a class="btn" href="#/numeros/${n.id}">Ver saúde do número</a><a class="btn sec" href="#/chaves">Criar chave API</a></div>`}`;
      }
    } else if (n.status === 'SCAN_QR_CODE') {
      if (last !== key) {
        $('#lg-main').innerHTML = `<div class="tabs" role="tablist"><button type="button" role="tab" data-t="qr" class="${tab === 'qr' ? 'on' : ''}" aria-selected="${tab === 'qr'}">QR code</button><button type="button" role="tab" data-t="code" class="${tab === 'code' ? 'on' : ''}" aria-selected="${tab === 'code'}">Código de 8 caracteres</button></div>
        ${tab === 'qr' ? `<div class="qr"><img id="qrimg" alt="QR code para associar o WhatsApp"></div><p class="lead" style="text-align:center">O QR renova-se sozinho. Esta página atualiza quando o número ligar.</p>`
          : `<form id="pair"><div class="f"><label for="pp">Número de telefone (formato internacional)</label><input id="pp" name="phone" inputmode="tel" placeholder="+2449XXXXXXXX" required></div><button class="btn" type="submit">Pedir código</button></form><div id="paircode"></div>`}`;
        $$('[data-t]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.t; last = ''; tick(); }));
        const pair = $('#pair');
        if (pair) pair.addEventListener('submit', (e) => {
          e.preventDefault();
          busy(pair.querySelector('button'), async () => {
            const r = await api('POST', `${base}/${id}/pairing-code`, { phone: pair.phone.value });
            $('#paircode').innerHTML = `<div class="paircode">${esc(r.code)}</div><p class="lead">Escreva este código no telemóvel em <em>Associar com número de telefone</em>.</p>`;
          });
        });
      }
      const img = $('#qrimg');
      if (img) img.src = `/console-api${base}/${id}/qr?t=${Date.now()}`;
    } else if (n.status === 'STOPPED' || n.status === 'FAILED') {
      if (last !== key) {
        $('#lg-main').innerHTML = `<p class="note ${n.status === 'FAILED' ? 'bad' : 'warn'}">A sessão está ${esc((STATUS[n.status] || [, n.status])[1].toLowerCase())}.</p><button class="btn" id="st" type="button">Iniciar sessão</button>`;
        $('#st').addEventListener('click', (e) => busy(e.currentTarget, () => api('POST', `${base}/${id}/start`).then(() => { last = ''; tick(); })));
      }
    } else if (last !== key) {
      $('#lg-main').innerHTML = `<p class="lead">${n.status.startsWith('PASSKEY') ? 'Confirme o pedido no telemóvel para terminar a associação.' : 'A iniciar o motor… o QR aparece em segundos.'}</p>`;
    }
    last = key;
  }
  await tick();
  every(4000, tick);
}

// Monitor de eventos

async function viewMonitor() {
  view.innerHTML = `<main><div class="head"><div><h1 class="page">Monitor de eventos</h1><p class="lead">Eventos do WAHA e da Losambo em tempo real, e o estado da entrega ao seu servidor.</p></div>
  <label class="row" style="gap:8px"><input type="checkbox" id="live" checked> Ao vivo</label></div>
  <div class="tablebox"><table><thead><tr><th>Quando</th><th>Evento</th><th>Sessão</th><th>Resumo</th><th>Entrega</th></tr></thead><tbody id="evs"><tr><td colspan="5" class="empty">A carregar…</td></tr></tbody></table></div></main>`;
  let rows = [];
  let maxId = 0;
  function summary(e) {
    const p = e.payload || {};
    if (e.event === 'message') return `${esc(p.from || '')}: ${esc(String(p.body || '').slice(0, 80))}`;
    if (e.event === 'session.status') return esc(p.status);
    if (e.event === 'message.ack') return esc(p.ackName || p.ack);
    if (e.event === 'otp.verified') return `${esc(p.id)} · ${esc(p.mode)}`;
    if (e.event === 'number.capping') return esc(CAPPING[p.cappingStatus] || p.cappingStatus);
    return esc(JSON.stringify(p).slice(0, 80));
  }
  function render() {
    const tb = $('#evs');
    if (!tb) return;
    tb.innerHTML = rows.length ? rows.map((e) => `<tr class="click" data-id="${e.id}"><td style="white-space:nowrap">${esc(ago(e.created_at))}</td><td><code>${esc(e.event)}</code></td><td>${e.session_name ? `<code>${esc(e.session_name)}</code>` : '—'}</td><td style="max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${summary(e)}</td><td style="font-size:13px;color:#4E5255">${esc(e.delivery || 'não subscrito')}</td></tr>
      <tr hidden data-p="${e.id}"><td colspan="5"><pre class="code">${esc(JSON.stringify(e.payload, null, 2))}</pre></td></tr>`).join('')
      : `<tr><td colspan="5" class="empty">Sem eventos ainda. Envie uma mensagem para um número ligado.</td></tr>`;
    $$('tr[data-id]', tb).forEach((tr) => tr.addEventListener('click', () => { const p = $(`tr[data-p="${tr.dataset.id}"]`, tb); p.hidden = !p.hidden; }));
  }
  async function load(all) {
    const fresh = await api('GET', `/events${all ? '' : `?after=${maxId}`}`).catch(() => []);
    if (all) rows = fresh;
    else if (fresh.length) rows = [...fresh, ...rows].slice(0, 200);
    else if (!all) return;
    maxId = rows.reduce((m, e) => Math.max(m, Number(e.id)), maxId);
    render();
  }
  await load(true);
  every(3000, () => { if ($('#live')?.checked) load(false); });
}

// OTP

async function viewOtp() {
  view.innerHTML = `<main><div class="head"><div><h1 class="page">OTP</h1><p class="lead">Teste o envio e a verificação inversa. Na sua app use <code>POST /v1/otp/send</code> e <code>/v1/otp/verify</code>.</p></div><a class="btn sec" href="/docs#otp">Ver API</a></div>
  <div class="grid2 even" style="margin-bottom:32px">
    <section class="card"><h2>A · Envio de OTP</h2>
      <p class="note warn"><strong>Risco médio:</strong> mensagens para números que nunca falaram consigo são o padrão que mais leva a bloqueios.</p>
      <form id="otp-send"><div class="f"><label for="o-to">Enviar para</label><input id="o-to" name="to" inputmode="tel" placeholder="+2449XXXXXXXX" required></div>
      <div class="f"><label for="o-app">Nome da app</label><input id="o-app" name="app" value="${esc(ME.tenant.name)}"></div>
      <label class="row" style="justify-content:flex-start"><input type="checkbox" name="fallback" checked> Se o número estiver limitado, devolver verificação inversa</label>
      <button class="btn" type="submit">Enviar código</button></form>
      <div id="otp-res"></div>
    </section>
    <section class="card" style="border:2px solid #F6821F"><h2>B · Verificação inversa <span class="pill warn" style="margin-left:6px">Recomendado</span></h2>
      <p class="note info"><strong>Risco baixo:</strong> é tráfego de entrada; o número do remetente é provado pelo próprio WhatsApp.</p>
      <form id="otp-rev"><div class="f"><label for="r-to">Número esperado (opcional)</label><input id="r-to" name="to" inputmode="tel" placeholder="+2449XXXXXXXX"></div>
      <button class="btn" type="submit">Gerar link wa.me</button></form>
      <div id="rev-res"></div>
    </section>
  </div>
  <h2 style="font-size:22px;margin:0 0 16px">Registos</h2>
  <div class="tablebox"><table style="min-width:760px"><thead><tr><th>ID</th><th>Modo</th><th>Telefone</th><th>Número</th><th>Estado</th><th>Criado</th></tr></thead><tbody id="otps"></tbody></table></div></main>`;
  remember('OTP', 'Registos', '#/otp');
  async function loadList() {
    const list = await api('GET', '/otps').catch(() => []);
    const tb = $('#otps');
    if (!tb) return;
    const pill = { verified: 'ok', sent: 'info', pending: 'warn', failed: 'bad', expired: 'mute' };
    tb.innerHTML = list.length ? list.map((o) => `<tr><td><code>${esc(o.id)}</code></td><td>${o.mode === 'reverse' ? 'Inversa' : 'Envio'}</td><td class="mono">${esc(fmtPhone(o.phone || (o.verified_from || '').split('@')[0]))}</td><td>${o.session_name ? `<code>${esc(o.session_name)}</code>` : '—'}</td><td><span class="pill ${pill[o.status] || 'mute'}">${esc(o.status)}</span>${o.error ? `<div style="font-size:12px;color:#A11D12;margin-top:4px">${esc(o.error.slice(0, 120))}</div>` : ''}</td><td>${esc(ago(o.created_at))}</td></tr>`).join('')
      : `<tr><td colspan="6" class="empty">Ainda não há OTP.</td></tr>`;
  }
  $('#otp-send').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    busy(f.querySelector('button'), async () => {
      const r = await api('POST', '/otps/send', { to: f.to.value, app: f.app.value || undefined, fallback: f.fallback.checked ? 'reverse' : undefined });
      if (r.mode === 'reverse') {
        $('#otp-res').innerHTML = `<p class="note warn" style="margin-top:16px">Número limitado — devolvido link de verificação inversa: <a href="${esc(r.link)}" target="_blank" rel="noopener">${esc(r.link)}</a></p>`;
      } else {
        $('#otp-res').innerHTML = `<form id="otp-ver" style="margin-top:20px"><p class="note ok">Enviado por <code>${esc(r.via)}</code> · <code>${esc(r.id)}</code> · expira em 5 min.</p>
        <div class="f"><label for="o-code">Código recebido</label><input id="o-code" name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="482 913" required></div><button class="btn sec" type="submit">Validar</button></form>`;
        $('#otp-ver').addEventListener('submit', (ev) => {
          ev.preventDefault();
          busy(ev.target.querySelector('button'), async () => {
            const v = await api('POST', '/otps/verify', { id: r.id, code: ev.target.code.value });
            toast(v.valid ? 'Código válido ✓' : `Inválido: ${v.status}`, !v.valid);
            loadList();
          });
        });
      }
      loadList();
    });
  });
  $('#otp-rev').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    busy(f.querySelector('button'), async () => {
      const r = await api('POST', '/otps/reverse', { to: f.to.value || undefined });
      $('#rev-res').innerHTML = `<div style="margin-top:20px"><p class="lead" style="margin-bottom:8px">Código <code>${esc(r.code)}</code> · abra no telemóvel e carregue em enviar:</p>
      ${r.link ? `<p><a class="btn" href="${esc(r.link)}" target="_blank" rel="noopener">Verificar no WhatsApp</a></p><p class="mono" style="font-size:13px;overflow-wrap:anywhere;color:#4E5255">${esc(r.link)}</p>` : '<p class="note warn">O número ainda não tem telefone conhecido.</p>'}
      <p id="rev-st" class="lead">${statusPill('STARTING').replace('A iniciar', 'À espera da mensagem…')}</p></div>`;
      loadList();
      every(3000, async () => {
        const v = await api('POST', '/otps/verify', { id: r.id }).catch(() => null);
        const st = $('#rev-st');
        if (v?.valid && st && !st.dataset.done) {
          st.dataset.done = '1';
          st.innerHTML = `<span class="pill ok"><i></i>Verificado ✓</span> de <span class="mono">${esc(v.from)}</span>`;
          loadList();
        }
      });
    });
  });
  loadList();
}

// Mensagens

async function viewMensagens() {
  view.innerHTML = `<main><div class="head"><div><h1 class="page">Mensagens e chat</h1><p class="lead">Mensagens transacionais enviadas e respostas recebidas. Só envie o que os seus clientes esperam receber.</p></div></div>
  <div class="grid2" style="margin-bottom:32px"><section class="card"><h2>Enviar mensagem de teste</h2>
    <form id="msg"><div class="f"><label for="m-to">Para</label><input id="m-to" name="to" inputmode="tel" placeholder="+2449XXXXXXXX" required></div>
    <div class="f"><label for="m-text">Texto</label><textarea id="m-text" name="text" required>Olá! A sua encomenda foi confirmada.</textarea></div>
    <button class="btn" type="submit">Enviar</button></form></section>
    <section class="card"><h2>Pela API</h2><pre class="code">POST /v1/messages
{
  "to": "+2449XXXXXXXX",
  "type": "text",
  "text": "Olá! A sua encomenda foi confirmada."
}</pre></section></div>
  <div class="tablebox"><table style="min-width:760px"><thead><tr><th></th><th>Contacto</th><th>Mensagem</th><th>Número</th><th>Estado</th><th>Quando</th></tr></thead><tbody id="msgs"></tbody></table></div></main>`;
  async function load() {
    const list = await api('GET', '/messages').catch(() => []);
    const tb = $('#msgs');
    if (!tb) return;
    tb.innerHTML = list.length ? list.map((m) => `<tr><td>${m.direction === 'in' ? '<span class="pill info">Recebida</span>' : '<span class="pill mute">Enviada</span>'}</td><td class="mono">${esc(m.chat_id)}</td><td style="max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.body || '[' + m.kind + ']')}</td><td>${m.session_name ? `<code>${esc(m.session_name)}</code>` : '—'}</td><td>${esc(m.ack || '')}</td><td>${esc(ago(m.created_at))}</td></tr>`).join('')
      : `<tr><td colspan="6" class="empty">Sem mensagens.</td></tr>`;
  }
  $('#msg').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    busy(f.querySelector('button'), async () => {
      const r = await api('POST', '/messages', { to: f.to.value, text: f.text.value });
      toast(`Enviada por ${r.via}`);
      load();
    });
  });
  await load();
  every(5000, load);
}

// Contactos — testar GET /v1/contacts (WAHA GET /api/contacts/all)

async function viewContactos() {
  const nums = (await api('GET', '/numbers').catch(() => [])).filter((n) => n.status === 'WORKING');
  const st = { via: '', limit: 100, offset: 0, sort_by: 'name', sort_order: 'asc' };
  view.innerHTML = `<main><div class="head"><div><h1 class="page">Contactos</h1><p class="lead">Os contactos WhatsApp de um número da conta. É o mesmo pedido que <code>GET /v1/contacts</code> faz na API.</p></div></div>
  ${nums.length ? '' : '<p class="note warn">Nenhum número ligado nesta conta. Os contactos aparecem quando a conta tiver um número com o estado <strong>Ligado</strong>.</p>'}
  <div class="grid2" style="margin-bottom:24px"><section class="card"><h2>Pedido</h2>
    <form id="cf">
      <div class="f"><label for="c-via">Número</label><select id="c-via" name="via"><option value="">Automático (o mais disponível)</option>${nums.map((n) => `<option value="${esc(n.session_name)}">${esc(n.session_name)} ${esc(fmtPhone(n.phone))}</option>`).join('')}</select></div>
      <div class="f"><label for="c-sort">Ordenar por</label><select id="c-sort" name="sort_by"><option value="name">Nome</option><option value="id">ID</option></select></div>
      <div class="f"><label for="c-order">Ordem</label><select id="c-order" name="sort_order"><option value="asc">A → Z</option><option value="desc">Z → A</option></select></div>
      <div class="f"><label for="c-limit">Por página</label><select id="c-limit" name="limit"><option>50</option><option selected>100</option><option>500</option><option>1000</option></select></div>
      <button class="btn" type="submit"${nums.length ? '' : ' disabled'}>Carregar contactos</button>
    </form></section>
    <section class="card"><h2>Pela API</h2><pre class="code" id="c-curl"></pre></section></div>
  <div class="head" style="align-items:center;margin-bottom:12px"><p class="lead" id="c-info" style="margin:0"></p>
    <div class="btns"><input id="c-q" type="search" placeholder="Filtrar nesta página…" aria-label="Filtrar contactos desta página" style="min-height:40px;border:1px solid #DCDDDF;border-radius:10px;padding:0 12px">
    <button class="btn sec" type="button" id="c-prev" disabled>Anterior</button><button class="btn sec" type="button" id="c-next" disabled>Seguinte</button></div></div>
  <div class="tablebox"><table style="min-width:760px"><thead><tr><th>Nome</th><th>Telefone</th><th>Nome no WhatsApp</th><th>Tipo</th><th>ID</th></tr></thead><tbody id="c-rows"><tr><td colspan="5" class="empty">Escolha as opções e carregue os contactos.</td></tr></tbody></table></div></main>`;
  let rows = [];
  const f = $('#cf');
  const qs = () => {
    const p = new URLSearchParams({ limit: st.limit, offset: st.offset, sort_by: st.sort_by, sort_order: st.sort_order });
    if (st.via) p.set('via', st.via);
    return p.toString();
  };
  const curl = () => {
    $('#c-curl').textContent = `curl "${ME.publicApiUrl}/contacts?${qs()}" \\\n  -H "Authorization: Bearer lsb_live_…"`;
  };
  const kind = (c) => c.is_group ? '<span class="chip">Grupo</span>' : c.is_business ? '<span class="chip">Empresa</span>' : c.is_my_contact ? '<span class="chip">Na agenda</span>' : '';
  const draw = () => {
    const term = $('#c-q').value.trim().toLowerCase();
    const list = term ? rows.filter((c) => [c.name, c.push_name, c.phone, c.id].some((v) => v && String(v).toLowerCase().includes(term))) : rows;
    $('#c-rows').innerHTML = list.length ? list.map((c) => `<tr><td style="font-weight:500">${esc(c.name || c.short_name || '—')}</td><td class="mono">${esc(c.phone ? fmtPhone('+' + c.phone) : '—')}</td><td>${esc(c.push_name || '—')}</td><td>${kind(c)}${c.is_blocked ? '<span class="pill bad">Bloqueado</span>' : ''}</td><td class="mono" style="font-size:12px">${esc(c.id)}</td></tr>`).join('')
      : `<tr><td colspan="5" class="empty">${rows.length ? 'Nenhum contacto corresponde ao filtro.' : 'Sem contactos nesta página.'}</td></tr>`;
  };
  async function load() {
    curl();
    const btn = f.querySelector('button[type=submit]');
    await busy(btn, async () => {
      const r = await api('GET', `/contacts?${qs()}`);
      rows = r.data;
      $('#c-info').textContent = r.count ? `Contactos ${r.offset + 1}–${r.offset + r.count} · número ${r.via}` : `Sem contactos a partir da posição ${r.offset + 1} · número ${r.via}`;
      $('#c-prev').disabled = st.offset === 0;
      $('#c-next').disabled = r.count < st.limit;
      draw();
    });
  }
  const read = () => Object.assign(st, { via: f.via.value, sort_by: f.sort_by.value, sort_order: f.sort_order.value, limit: Number(f.limit.value) });
  f.addEventListener('change', () => { read(); curl(); });
  f.addEventListener('submit', (e) => { e.preventDefault(); read(); st.offset = 0; load(); });
  $('#c-prev').addEventListener('click', () => { st.offset = Math.max(0, st.offset - st.limit); load(); });
  $('#c-next').addEventListener('click', () => { st.offset += st.limit; load(); });
  $('#c-q').addEventListener('input', draw);
  curl();
}

// Webhooks

async function viewWebhooks() {
  const { endpoint: ep, events } = await api('GET', '/webhook');
  const on = new Set(ep?.events || ['message', 'session.status', 'otp.verified']);
  view.innerHTML = `<main><h1 class="page">Webhooks</h1><p class="lead" style="margin-bottom:24px">Receba no seu servidor as mensagens, recibos de leitura e mudanças de estado dos seus números.</p>
  <div class="grid2">
    <section class="card" aria-labelledby="h-wh"><h2 id="h-wh">Endpoint</h2>
      <form id="wh">
        <div class="f"><label for="wurl">URL</label><input id="wurl" name="url" type="url" value="${esc(ep?.url || '')}" placeholder="https://api.minhaloja.ao/losambo/webhook" required></div>
        <fieldset><legend>Eventos</legend><div class="evlist">
          ${events.map((ev) => `<label class="ev"><input type="checkbox" name="ev" value="${ev}" ${on.has(ev) ? 'checked' : ''}><span class="t">${esc(EVENT_LABEL[ev] || ev)}</span><code>${esc(ev)}</code>${['otp.verified', 'number.capping'].includes(ev) ? '<span class="chip">Losambo</span>' : ''}</label>`).join('')}
        </div></fieldset>
        <div class="frow">
          <div class="f"><label for="pol">Repetições</label><select id="pol" name="retry_policy">${[['exponential', 'Exponencial'], ['linear', 'Linear'], ['constant', 'Constante']].map(([v, l]) => `<option value="${v}" ${ep?.retry_policy === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="f"><label for="att">Tentativas</label><input id="att" name="attempts" type="number" min="1" max="30" value="${ep?.attempts ?? 15}"></div>
          <div class="f"><label for="del">Atraso (s)</label><input id="del" name="delay_seconds" type="number" min="1" value="${ep?.delay_seconds ?? 2}"></div>
        </div>
        <div class="btns"><button class="btn" type="submit">Guardar</button><button class="btn sec" type="button" id="wh-test" ${ep ? '' : 'disabled'}>Enviar evento de teste</button></div>
      </form>
    </section>
    <section aria-label="Segurança e exemplo" style="display:flex;flex-direction:column;gap:20px">
      <div class="card"><h2>Assinatura HMAC</h2><p class="lead" style="margin-bottom:14px">Cada pedido traz <code>X-Losambo-Signature: sha256=…</code> (HMAC-SHA256 do corpo). Confirme-a para saber que veio do Losambo.</p>
        <div class="secret"><span id="sec">${ep ? esc(ep.secret) : 'Guarde o endpoint para gerar o segredo'}</span>${ep ? '<button class="btn sec" type="button" id="show">Mostrar</button><button class="btn sec" type="button" id="rot">Renovar</button>' : ''}</div></div>
      <div class="card"><p style="margin:0 0 10px;font-size:13px;color:#4E5255">Exemplo · message</p><pre class="code">{
  "id": 1042,
  "event": "message",
  "session": "${esc(ME.tenant.slug)}-01",
  "timestamp": 1793750508000,
  "payload": {
    "from": "2449XXXXXXXX@c.us",
    "body": "LSB-482913",
    "fromMe": false
  }
}</pre></div>
    </section>
  </div></main>`;
  $('#wh').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    busy(f.querySelector('button[type=submit]'), async () => {
      await api('PUT', '/webhook', {
        url: f.url.value,
        events: $$('input[name=ev]:checked', f).map((i) => i.value),
        retry_policy: f.retry_policy.value,
        attempts: Number(f.attempts.value),
        delay_seconds: Number(f.delay_seconds.value),
      });
      toast('Webhook guardado');
      viewWebhooks();
    });
  });
  $('#wh-test')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
    await api('POST', '/webhook/test');
    toast('Evento de teste enviado — veja o Monitor de eventos');
  }));
  $('#show')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
    $('#sec').textContent = (await api('GET', '/webhook/secret')).secret;
  }));
  $('#rot')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
    if (!confirm('Renovar o segredo? O seu servidor tem de passar a usar o novo.')) return;
    $('#sec').textContent = (await api('POST', '/webhook/rotate')).secret;
    toast('Segredo renovado');
  }));
}

// Chaves API

async function viewChaves() {
  const [keys, numbers] = await Promise.all([api('GET', '/keys'), api('GET', '/numbers')]);
  const byId = new Map(numbers.map((n) => [n.id, n.session_name]));
  remember('Chaves API', 'Produção', '#/chaves');
  view.innerHTML = `<main>
  <div class="head"><div><h1 class="page">Chaves API</h1><p class="lead">Dê a cada sistema só as permissões de que precisa.</p></div><button type="button" class="btn" id="new">+ Criar chave</button></div>
  <div id="newkey"></div>
  <div class="tablebox"><table style="min-width:760px"><thead><tr><th>Nome</th><th>Chave</th><th>Números</th><th>Permissões</th><th>Estado</th><th><span class="sr">Ações</span></th></tr></thead>
  <tbody>${keys.length ? keys.map((k) => `<tr><td style="font-weight:500">${esc(k.name)}</td><td class="mono">${esc(k.display)}</td>
    <td>${k.number_ids ? k.number_ids.map((i) => `<code>${esc(byId.get(i) || i)}</code>`).join(' ') : 'Todos'}</td>
    <td>${k.permissions.map((p) => `<span class="chip">${esc(PERM_LABEL[p] || p)}</span>`).join('')}</td>
    <td>${k.active ? '<span class="pill ok">Ativa</span>' : '<span class="pill mute">Desativada</span>'}</td>
    <td style="text-align:right;white-space:nowrap"><button class="btn sec" type="button" data-toggle="${k.id}" data-active="${k.active}">${k.active ? 'Desativar' : 'Ativar'}</button> <button class="btn danger" type="button" data-del="${k.id}">Apagar</button></td></tr>`).join('')
    : `<tr><td colspan="6" class="empty">Ainda não há chaves.</td></tr>`}</tbody></table></div>
  <p class="lead">Permissões: <strong>ler</strong> mensagens e conversas · <strong>enviar</strong> mensagens e OTP · <strong>controlar</strong> ligar, parar e religar números · <strong>definições</strong> do número · <strong>apagar</strong> o número.</p>
  <dialog id="dlg"><form method="dialog" class="dlg" id="kf">
    <h2>Criar chave</h2><p class="lead" style="margin-bottom:18px">A chave completa só é mostrada uma vez.</p>
    <div class="f"><label for="k-name">Nome</label><input id="k-name" name="name" placeholder="Backend produção" required></div>
    <div class="f"><label for="k-env">Tipo</label><select id="k-env" name="env"><option value="live">Produção (lsb_live_)</option><option value="test">Testes (lsb_test_)</option></select></div>
    <fieldset><legend>Permissões</legend><div class="btns">${Object.entries(PERM_LABEL).map(([v, l]) => `<label class="ev"><input type="checkbox" name="perm" value="${v}" ${['read', 'send'].includes(v) ? 'checked' : ''}>${l}</label>`).join('')}</div></fieldset>
    <fieldset><legend>Números</legend><div class="evlist"><label class="ev"><input type="radio" name="scope" value="all" checked> Todos os números</label>
      ${numbers.map((n) => `<label class="ev"><input type="checkbox" name="num" value="${n.id}"> <code>${esc(n.session_name)}</code> ${esc(fmtPhone(n.phone))}</label>`).join('')}</div></fieldset>
    <div class="btns" style="justify-content:flex-end"><button class="btn sec" value="cancel" formnovalidate>Cancelar</button><button class="btn" value="ok">Criar chave</button></div>
  </form></dialog></main>`;
  const dlg = $('#dlg');
  $('#new').addEventListener('click', () => dlg.showModal());
  $$('input[name=num]').forEach((c) => c.addEventListener('change', () => { $('input[name=scope]').checked = !$$('input[name=num]:checked').length; }));
  $('input[name=scope]').addEventListener('change', () => $$('input[name=num]').forEach((c) => { c.checked = false; }));
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue !== 'ok') return;
    const f = $('#kf');
    try {
      const nums = $$('input[name=num]:checked', f).map((i) => Number(i.value));
      const k = await api('POST', '/keys', {
        name: f.name.value,
        env: f.env.value,
        permissions: $$('input[name=perm]:checked', f).map((i) => i.value),
        number_ids: nums.length ? nums : null,
      });
      await viewChaves();
      $('#newkey').innerHTML = `<div class="card" style="margin-bottom:24px;border:2px solid #12A150"><h2>Chave criada — copie agora</h2><p class="lead" style="margin-bottom:12px">Não voltamos a mostrar esta chave.</p><div class="secret"><span id="ks">${esc(k.secret)}</span><button class="btn sec" type="button" id="copy">Copiar</button></div></div>`;
      $('#copy').addEventListener('click', () => navigator.clipboard.writeText(k.secret).then(() => toast('Copiada')));
    } catch (err) {
      toast(err.message, true);
    }
  });
  $$('[data-toggle]').forEach((b) => b.addEventListener('click', () => busy(b, async () => {
    await api('PATCH', `/keys/${b.dataset.toggle}`, { active: b.dataset.active !== 'true' });
    viewChaves();
  })));
  $$('[data-del]').forEach((b) => b.addEventListener('click', () => busy(b, async () => {
    if (!confirm('Apagar esta chave? Os sistemas que a usam deixam de funcionar.')) return;
    await api('DELETE', `/keys/${b.dataset.del}`);
    viewChaves();
  })));
}

// Administração

const PLANS = [
  ['free', 'Grátis', '0 Kz · números Losambo'],
  ['startup', 'Startup', '[PREÇO] Kz/mês · números Losambo'],
  ['business', 'Negócio', '[PREÇO] Kz/mês · números próprios ilimitados'],
  ['internal', 'Interno', '0 Kz para sempre · sem fatura · sem limite do plano'],
];

async function viewAdmin(tenantId) {
  if (!ME.user.is_admin) {
    view.innerHTML = `<main><p class="note bad">Só para super-admin.</p></main>`;
    return;
  }
  const [tenants, w] = await Promise.all([api('GET', '/admin/tenants'), api('GET', '/admin/waha')]);
  const t = tenants.find((x) => String(x.id) === String(tenantId));
  const internal = tenants.filter((x) => x.plan === 'internal');
  if (!t) {
    view.innerHTML = `<main><div class="head"><div><h1 class="page">Contas</h1><p class="lead">Todas as contas Losambo e o estado do motor.</p></div></div>
    <div class="card" style="margin-bottom:24px"><h2>Servidor WAHA</h2>
      ${w.version ? `<p class="note ok">Ligado a <code>${esc(w.url)}</code> · WAHA ${esc(w.version.version)} · motor <code>${esc(w.version.engine)}</code> · ${esc(w.version.tier)} · ${w.sessions.length} sessões</p>` : `<p class="note bad">${esc(w.error)}</p>`}
    </div>
    <div class="tablebox"><table><thead><tr><th>Conta</th><th>Plano</th><th>Subscrição</th><th>Números</th><th>Mensagens este mês</th><th>Criada</th><th></th></tr></thead><tbody>
    ${tenants.map((x) => `<tr><td style="font-weight:500">${esc(x.name)} <code>${esc(x.slug)}</code></td><td>${esc((PLANS.find((p) => p[0] === x.plan) || [, x.plan])[1])}</td><td>${subPill(x)}</td><td>${x.numbers}</td><td>${x.messages_month}</td><td>${esc(dt(x.created_at))}</td><td style="text-align:right"><a href="#/admin/${x.id}">Plano</a></td></tr>`).join('')}
    </tbody></table></div></main>`;
    return;
  }
  view.innerHTML = `<main>
  <p style="margin:0 0 6px;font-size:14px;color:#4E5255"><a href="#/admin">Contas</a> / ${esc(t.name)}</p>
  <h1 class="page">Plano da conta</h1><p class="lead" style="margin-bottom:24px">Escolha como esta conta é cobrada.</p>
  <form id="pf">
  <fieldset><legend class="sr">Plano</legend><div class="plans">
    ${PLANS.map(([v, l, d]) => `<label class="plan"><input type="radio" name="plan" value="${v}" ${t.plan === v ? 'checked' : ''}><b>${l}${v === 'internal' ? ' <span class="chip" style="margin-left:6px">Custo zero</span>' : ''}</b><span class="d">${d}</span></label>`).join('')}
  </div></fieldset>
  <section class="card" id="int" style="margin-bottom:24px" aria-labelledby="int-h"><h2 id="int-h">O que o plano Interno faz</h2>
    <div class="kpis" style="margin-bottom:20px">
      <div class="kpi"><p><strong>Nunca gera fatura.</strong> Fica fora do ciclo de cobrança e não pede método de pagamento.</p></div>
      <div class="kpi"><p><strong>Sem limites do plano.</strong> Números, mensagens e OTP sem teto mensal.</p></div>
      <div class="kpi"><p><strong>Proteção mantém-se.</strong> O ritmo humano e os tetos por número continuam ativos para não bloquear o WhatsApp.</p></div>
    </div>
    <div class="frow" style="grid-template-columns:1fr 1fr">
      <div class="f"><label for="motivo">Motivo</label><select id="motivo" name="reason">${['Projeto próprio', 'Parceiro', 'Testes internos'].map((r) => `<option ${t.plan_reason === r ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
      <div class="f"><label for="validade">Válido até (vazio = sem data de fim)</label><input id="validade" name="until" type="date" value="${t.plan_until ? String(t.plan_until).slice(0, 10) : ''}"></div>
    </div>
  </section>
  <div class="btns" style="justify-content:flex-end;margin-bottom:32px"><a class="btn sec" href="#/admin">Cancelar</a><button class="btn" type="submit">Guardar plano</button></div>
  </form>
  <section class="card" style="margin-bottom:24px" aria-labelledby="num-h">
    <h2 id="num-h">Números da conta</h2>
    <p class="lead" style="margin-bottom:14px">Escolha os números Losambo que esta conta pode usar. ${t.plan === 'business' || t.plan === 'internal' ? 'Este plano também pode ligar números próprios.' : 'Neste plano a conta só pode usar números Losambo.'}</p>
    <form id="nf"><div class="evlist" id="nf-list"><p class="lead">A carregar…</p></div>
    <div class="btns" style="margin-top:14px"><button class="btn" type="submit">Guardar números</button><a class="btn sec" href="#/admin-numeros">Gerir números Losambo</a></div></form>
    <div id="own-list"></div>
  </section>
  <section class="card" style="margin-bottom:32px" aria-labelledby="sub-h">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:6px"><h2 id="sub-h" style="margin:0">Subscrição</h2>${subPill(t)}</div>
    <p class="lead" style="margin-bottom:18px">A API <code>/v1</code> e as chaves WAHA da conta só ficam ligadas com a subscrição ativa. ${t.plan === 'internal' ? 'O plano Interno conta sempre como ativo.' : ''}</p>
    <form id="sf"><div class="frow">
      <div class="f"><label for="s-st">Estado</label><select id="s-st" name="status">${Object.entries(SUB_LABEL).map(([v, [, l]]) => `<option value="${v}" ${t.subscription_status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="f"><label for="s-end">Ativa até (vazio = sem data de fim)</label><input id="s-end" name="ends_at" type="date" value="${t.subscription_ends_at ? String(t.subscription_ends_at).slice(0, 10) : ''}"></div>
      <div class="f" style="justify-content:flex-end"><button class="btn" type="submit">Guardar subscrição</button></div>
    </div></form>
    <div class="sep"></div>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px"><h3 style="margin:0;font-size:16px">Chaves WAHA da conta</h3><button class="btn sec" type="button" id="ksync">Criar / sincronizar chaves</button></div>
    <div id="wkeys" class="lead">A carregar…</div>
  </section>
  <section aria-labelledby="list-h"><h2 id="list-h" style="font-size:22px;margin:0 0 16px">Contas no plano Interno</h2>
  <div class="tablebox"><table><thead><tr><th>Conta</th><th>Motivo</th><th>Números</th><th>Custo</th></tr></thead><tbody>
  ${internal.length ? internal.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.plan_reason || '—')}</td><td>${x.numbers}</td><td>0 Kz</td></tr>`).join('') : '<tr><td colspan="4" class="empty">Nenhuma.</td></tr>'}
  </tbody></table></div></section></main>`;
  async function loadKeys() {
    const rows = await api('GET', `/admin/tenants/${t.id}/waha-keys`).catch((e) => { toast(e.message, true); return []; });
    $('#wkeys').innerHTML = rows.length ? `<div class="tablebox" style="margin:0"><table><thead><tr><th>Sessão</th><th>Tipo</th><th>Número</th><th>Chave WAHA</th><th>Estado</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td><code>${esc(r.session_name)}</code></td><td>${typeChip(r)}</td><td class="mono">${esc(fmtPhone(r.phone))}</td><td>${r.waha_key_id ? `<code>${esc(r.waha_key_id)}</code>` : '<span class="pill bad">Por criar</span>'}</td><td>${r.waha_key_id ? (r.waha_key_active ? '<span class="pill ok">Ligada</span>' : '<span class="pill mute">Desligada</span>') : '—'}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="note warn">Esta conta ainda não tem números. Atribua um número Losambo acima — a chave WAHA da conta é criada nesse momento.</p>';
  }
  loadKeys();
  async function loadNums() {
    const d = await api('GET', `/admin/tenants/${t.id}/numbers`).catch((e) => { toast(e.message, true); return null; });
    if (!d) return;
    const on = new Set(d.assigned);
    $('#nf-list').innerHTML = d.platform.length ? d.platform.map((n) => {
      const taken = n.owner_id !== null && n.owner_id !== t.id;
      const who = n.owner_id === null ? '<span class="chip">Livre</span>' : taken ? `<span class="chip">De: ${esc(n.owner_name)}</span>` : '<span class="chip">Desta conta</span>';
      return `<label class="ev"${taken ? ' style="opacity:.6"' : ''}><input type="checkbox" name="pn" value="${n.id}" ${on.has(n.id) ? 'checked' : ''} ${taken ? 'disabled' : ''}><span class="t"><code>${esc(n.session_name)}</code> ${esc(fmtPhone(n.phone))}</span>${statusPill(n.status)}${who}</label>`;
    }).join('')
      : '<p class="note warn">Ainda não há números Losambo. <a href="#/admin-numeros">Ligue o primeiro</a>.</p>';
    $('#own-list').innerHTML = d.own.length ? `<div class="sep"></div><h3 style="margin:0 0 10px;font-size:16px">Números próprios</h3>${d.own.map((n) => `<p class="lead"><code>${esc(n.session_name)}</code> ${esc(fmtPhone(n.phone))} ${statusPill(n.status)}</p>`).join('')}` : '';
  }
  loadNums();
  $('#nf').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.target.querySelector('button[type=submit]'), async () => {
      await api('PUT', `/admin/tenants/${t.id}/numbers`, { number_ids: $$('input[name=pn]:checked', e.target).map((i) => Number(i.value)) });
      toast('Números da conta guardados');
      loadNums();
      loadKeys();
    });
  });
  $('#ksync').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const r = await api('POST', `/admin/tenants/${t.id}/waha-keys/sync`);
    toast(r.errors.length ? `Erros: ${r.errors.join('; ')}` : `Chaves sincronizadas (${r.updated} alteradas)`, r.errors.length > 0);
    loadKeys();
  }));
  $('#sf').addEventListener('submit', (e) => {
    e.preventDefault();
    const sf = e.target;
    busy(sf.querySelector('button'), async () => {
      const r = await api('PUT', `/admin/tenants/${t.id}/subscription`, { status: sf.status.value, ends_at: sf.ends_at.value || null });
      toast(r.keys.errors.length ? `Subscrição guardada, mas: ${r.keys.errors.join('; ')}` : 'Subscrição guardada e chaves WAHA sincronizadas', r.keys.errors.length > 0);
      if (t.id === ME.tenant.id) await loadMe();
      viewAdmin(t.id);
    });
  });
  const f = $('#pf');
  const sync = () => { $('#int').hidden = f.plan.value !== 'internal'; };
  $$('input[name=plan]', f).forEach((r) => r.addEventListener('change', sync));
  sync();
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(f.querySelector('button[type=submit]'), async () => {
      await api('PUT', `/admin/tenants/${t.id}/plan`, { plan: f.plan.value, reason: f.reason.value, until: f.until.value || null });
      toast('Plano guardado');
      if (t.id === ME.tenant.id) await loadMe();
      viewAdmin(t.id);
    });
  });
}

// Admin — números Losambo (cada um de uma só conta)

async function viewAdminNumeros() {
  if (!ME.user.is_admin) {
    view.innerHTML = `<main><p class="note bad">Só para super-admin.</p></main>`;
    return;
  }
  const rows = await api('GET', '/admin/platform-numbers');
  view.innerHTML = `<main>
  <div class="head"><div><h1 class="page">Números Losambo</h1><p class="lead">Os números que a Losambo fornece às contas. Cada conta a que atribuir um número recebe uma chave WAHA própria para ele.</p></div>
  <button type="button" class="btn" id="add">+ Ligar número Losambo</button></div>
  <p class="note info">Cada número Losambo pertence a <strong>uma só conta</strong> — as respostas dos contactos vão sempre para essa conta. Contas Grátis e Startup só enviam por estes números. Cada conta nova recebe automaticamente um número livre marcado <strong>Para contas novas</strong>; números sem conta enviam os códigos de entrada com WhatsApp.</p>
  <div class="tablebox"><table style="min-width:860px"><thead><tr><th>Número</th><th>Sessão</th><th>Estado</th><th>Conta</th><th>Para contas novas</th><th>Máx./min</th><th><span class="sr">Ações</span></th></tr></thead>
  <tbody>${rows.length ? rows.map((n) => `<tr><td class="mono">${esc(fmtPhone(n.phone))}</td><td><code>${esc(n.session_name)}</code></td><td>${statusPill(n.status)}</td><td>${n.owner_name ? esc(n.owner_name) : '<span class="pill mute">Livre</span>'}</td>
    <td><input type="checkbox" data-def="${n.id}" ${n.is_default ? 'checked' : ''} aria-label="Dar ${esc(n.session_name)} a uma conta nova"></td>
    <td><input class="in" type="number" min="1" max="60" style="width:80px;min-height:36px" data-rpm="${n.id}" value="${n.max_per_minute}" aria-label="Máximo por minuto"></td>
    <td style="text-align:right;white-space:nowrap">${n.status === 'WORKING' ? '' : `<a class="btn sec" href="#/admin-numeros/ligar/${n.id}">Ligar</a> `}<button class="btn sec" type="button" data-act="restart" data-id="${n.id}">Reiniciar</button> <button class="btn danger" type="button" data-del="${n.id}" data-owner="${esc(n.owner_name || '')}">Apagar</button></td></tr>`).join('')
    : `<tr><td colspan="7" class="empty">Ainda não há números Losambo. Ligue o primeiro para as contas poderem enviar.</td></tr>`}</tbody></table></div></main>`;
  $('#add').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const n = await api('POST', '/admin/platform-numbers');
    location.hash = `#/admin-numeros/ligar/${n.id}`;
  }));
  $$('[data-def]').forEach((c) => c.addEventListener('change', async () => {
    try {
      await api('PATCH', `/admin/platform-numbers/${c.dataset.def}`, { is_default: c.checked });
      toast(c.checked ? 'Contas novas vão receber este número' : 'Deixa de ser atribuído a contas novas');
    } catch (err) { toast(err.message, true); c.checked = !c.checked; }
  }));
  $$('[data-rpm]').forEach((i) => i.addEventListener('change', async () => {
    try {
      await api('PATCH', `/admin/platform-numbers/${i.dataset.rpm}`, { max_per_minute: Number(i.value) });
      toast('Ritmo guardado');
    } catch (err) { toast(err.message, true); }
  }));
  $$('[data-act]').forEach((b) => b.addEventListener('click', () => busy(b, async () => {
    await api('POST', `/admin/platform-numbers/${b.dataset.id}/${b.dataset.act}`);
    toast('Pedido enviado ao WAHA');
    setTimeout(viewAdminNumeros, 1200);
  })));
  $$('[data-del]').forEach((b) => b.addEventListener('click', () => busy(b, async () => {
    if (!confirm(b.dataset.owner ? `Apagar este número? A conta ${b.dataset.owner} deixa de o poder usar e a chave WAHA dela é apagada.` : 'Apagar este número?')) return;
    await api('DELETE', `/admin/platform-numbers/${b.dataset.del}`);
    viewAdminNumeros();
  })));
}

// Pesquisa

async function viewPesquisa(q) {
  q = decodeURIComponent(q || '').trim().toLowerCase();
  const [numbers, otps, msgs] = await Promise.all([api('GET', '/numbers'), api('GET', '/otps'), api('GET', '/messages')]);
  const hit = (...v) => v.some((x) => String(x ?? '').toLowerCase().includes(q));
  const ns = numbers.filter((n) => hit(n.session_name, n.phone, n.me_name));
  const os = otps.filter((o) => hit(o.id, o.phone, o.app));
  const ms = msgs.filter((m) => hit(m.chat_id, m.body));
  view.innerHTML = `<main><h1 class="page">Pesquisa: “${esc(q)}”</h1><p class="lead" style="margin-bottom:24px">${ns.length + os.length + ms.length} resultados</p>
  ${ns.map((n) => `<a class="li" href="#/numeros/${n.id}"><span style="flex:1"><span style="color:#6B6F73">Números /</span> ${esc(n.session_name)} ${esc(fmtPhone(n.phone))}</span>${icon.chev}</a>`).join('')}
  ${os.map((o) => `<a class="li" href="#/otp"><span style="flex:1"><span style="color:#6B6F73">OTP /</span> ${esc(o.id)} · ${esc(o.status)}</span>${icon.chev}</a>`).join('')}
  ${ms.map((m) => `<a class="li" href="#/mensagens"><span style="flex:1"><span style="color:#6B6F73">Mensagens /</span> ${esc(m.chat_id)}: ${esc((m.body || '').slice(0, 60))}</span>${icon.chev}</a>`).join('')}
  </main>`;
}

// Equipa interna — programa Grátis (contas Grátis com a API ativa)

async function viewGratis() {
  if (!ME.user.is_admin && !ME.user.is_staff) {
    view.innerHTML = `<main><p class="note bad">Só para a equipa interna (contas do plano Interno).</p></main>`;
    return;
  }
  const rows = await api('GET', '/staff/free-program');
  const active = (x) => x.subscription_status === 'active' && (!x.subscription_ends_at || new Date(x.subscription_ends_at) > new Date());
  const members = rows.filter(active).length;
  view.innerHTML = `<main><div class="head"><div><h1 class="page">Programa Grátis</h1>
    <p class="lead">Contas do plano Grátis. As que estão no programa têm a API e os envios ativos, dentro do limite mensal do plano; as outras só veem a consola.</p></div></div>
  <p class="note info">${members} de ${rows.length} conta(s) no programa. Só aparecem contas com o e-mail confirmado. Planos pagos e Interno são geridos pelo super-admin.</p>
  <div class="tablebox"><table style="min-width:820px"><thead><tr><th>Conta</th><th>Responsável</th><th>Mensagens este mês</th><th>Estado</th><th>Até</th><th><span class="sr">Ações</span></th></tr></thead><tbody>
  ${rows.length ? rows.map((x) => `<tr>
    <td style="font-weight:500">${esc(x.name)} <code>${esc(x.slug)}</code><div style="font-size:12px;color:#4E5255">criada ${esc(dt(x.created_at))}</div></td>
    <td>${esc(x.owner_name || '—')}<div style="font-size:12px;color:#4E5255">${esc(x.owner_email || (x.owner_phone ? '+' + x.owner_phone : ''))}</div></td>
    <td>${x.messages_month}</td>
    <td>${active(x) ? '<span class="pill ok">No programa</span>' : '<span class="pill mute">Fora</span>'}</td>
    <td><input type="date" data-until="${x.id}" value="${x.subscription_ends_at ? esc(x.subscription_ends_at.slice(0, 10)) : ''}" aria-label="Data de fim para ${esc(x.name)}" style="min-height:36px;border:1px solid #DCDDDF;border-radius:8px;padding:0 8px"></td>
    <td style="text-align:right;white-space:nowrap">${active(x)
      ? `<button class="btn sec" type="button" data-save="${x.id}">Guardar data</button> <button class="btn danger" type="button" data-out="${x.id}">Retirar</button>`
      : `<button class="btn" type="button" data-in="${x.id}">Adicionar ao programa</button>`}</td></tr>`).join('')
    : '<tr><td colspan="6" class="empty">Ainda não há contas Grátis com e-mail confirmado.</td></tr>'}
  </tbody></table></div></main>`;
  const set = (id, member, btn) => busy(btn, async () => {
    const until = $(`input[data-until="${id}"]`).value || null;
    const r = await api('PUT', `/staff/free-program/${id}`, { member, ends_at: member ? until : null });
    toast(r.keys.errors.length ? `Guardado, mas: ${r.keys.errors.join('; ')}` : member ? 'Conta no programa Grátis' : 'Conta retirada do programa', r.keys.errors.length > 0);
    viewGratis();
  });
  $$('[data-in]').forEach((b) => b.addEventListener('click', () => set(b.dataset.in, true, b)));
  $$('[data-save]').forEach((b) => b.addEventListener('click', () => set(b.dataset.save, true, b)));
  $$('[data-out]').forEach((b) => b.addEventListener('click', () => {
    if (confirm('Retirar esta conta do programa Grátis? A API e os envios dela ficam desligados.')) set(b.dataset.out, false, b);
  }));
}

// Router

async function route() {
  cleanups.forEach((f) => f());
  cleanups = [];
  $('#side').classList.remove('open');
  const parts = (location.hash.replace(/^#\/?/, '') || '').split('/');
  const [r = '', a, b] = parts;
  $$('#nav a').forEach((el) => el.classList.toggle('on', el.dataset.r === (r || 'inicio')));
  try {
    if (!r) await viewInicio();
    else if (r === 'numeros' && a === 'ligar') await viewLigar(b);
    else if (r === 'numeros') await viewNumeros(a);
    else if (r === 'monitor') await viewMonitor();
    else if (r === 'otp') await viewOtp();
    else if (r === 'mensagens') await viewMensagens();
    else if (r === 'contactos') await viewContactos();
    else if (r === 'webhooks') await viewWebhooks();
    else if (r === 'chaves') await viewChaves();
    else if (r === 'gratis') await viewGratis();
    else if (r === 'admin') await viewAdmin(a);
    else if (r === 'admin-numeros' && a === 'ligar') await viewLigar(b, true);
    else if (r === 'admin-numeros') await viewAdminNumeros();
    else if (r === 'pesquisa') await viewPesquisa(a);
    else view.innerHTML = `<main><p class="lead">Página não encontrada.</p></main>`;
  } catch (err) {
    view.innerHTML = `<main><p class="note bad">${esc(err.message)}</p></main>`;
  }
  window.scrollTo(0, 0);
}

async function loadMe() {
  ME = await api('GET', '/me');
  $('#tenant-name').textContent = ME.tenant.name;
  $('#plan-label').textContent = `Plano ${ME.tenant.plan_label}`;
  $('#user-email').textContent = ME.user.email || (ME.user.phone ? '+' + ME.user.phone : '');
  $('#nav-admin').hidden = !ME.user.is_admin;
  $('#nav-staff').hidden = !ME.user.is_admin && !ME.user.is_staff;
  const sub = ME.subscription;
  const banner = $('#sub-banner');
  banner.hidden = sub.active;
  if (!sub.active) {
    const why = { expired: 'expirou', canceled: 'foi cancelada', inactive: 'ainda não está ativa' }[sub.status] || 'não está ativa';
    banner.innerHTML = `<strong>A subscrição ${why}.</strong> A API (<code>/v1</code>), os envios e a ligação de números estão desativados, e as chaves WAHA da conta estão desligadas. Pode continuar a ver a consola. Para ativar, contacte a equipa Losambo.`;
  }
}

const SUB_LABEL = { active: ['ok', 'Ativa'], inactive: ['mute', 'Inativa'], expired: ['bad', 'Expirada'], canceled: ['bad', 'Cancelada'] };
function subPill(t) {
  if (t.plan === 'internal') return '<span class="pill ok">Interno</span>';
  const expired = t.subscription_status === 'active' && t.subscription_ends_at && new Date(t.subscription_ends_at) <= new Date();
  const [cls, label] = expired ? SUB_LABEL.expired : SUB_LABEL[t.subscription_status] || ['mute', t.subscription_status];
  return `<span class="pill ${cls}">${label}</span>${t.subscription_ends_at ? `<div style="font-size:12px;color:#4E5255;margin-top:4px">até ${esc(new Date(t.subscription_ends_at).toLocaleDateString('pt-PT'))}</div>` : ''}`;
}

async function wahaBadge() {
  try {
    const o = await fetch('/console-api/overview').then((r) => r.json());
    $('#waha-state').innerHTML = o.waha ? '<span class="pill ok"><i></i>WAHA ligado</span>' : '<span class="pill bad"><i></i>WAHA em baixo</span>';
  } catch {
    // ignorar
  }
}

$('#logout').addEventListener('click', async () => {
  await api('POST', '/auth/logout');
  location.href = '/entrar';
});
$('#menu').addEventListener('click', () => $('#side').classList.toggle('open'));
$('#qs').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.value.trim()) location.hash = `#/pesquisa/${encodeURIComponent(e.target.value.trim())}`;
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    ($('#big') || $('#qs')).focus();
  }
});
addEventListener('hashchange', route);

loadMe().then(() => {
  route();
  wahaBadge();
});
