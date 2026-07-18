'use strict';

const $ = (id) => document.getElementById(id);
const state = { projects: [], current: null, demo: false, clouds: null };

const REGIONS = {
  aws: [
    ['ap-south-1', 'ap-south-1 (Mumbai)'],
    ['us-east-1', 'us-east-1 (N. Virginia)'],
    ['eu-west-1', 'eu-west-1 (Ireland)'],
  ],
  gcp: [
    ['asia-south1', 'asia-south1 (Mumbai)'],
    ['us-central1', 'us-central1 (Iowa)'],
    ['europe-west1', 'europe-west1 (Belgium)'],
  ],
  azure: [
    ['centralindia', 'centralindia (Pune)'],
    ['eastus', 'eastus (Virginia)'],
    ['westeurope', 'westeurope (Netherlands)'],
  ],
};

async function api(path, opts) {
  const res = await fetch(path, {
    method: opts?.body ? 'POST' : 'GET',
    headers: opts?.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json();
}

function currentProject() {
  return state.projects.find((p) => p.name === state.current);
}

// ---------- rendering ----------

function renderProjects() {
  const sel = $('project-select');
  sel.innerHTML = '';
  for (const p of state.projects) {
    const o = document.createElement('option');
    o.value = p.name;
    o.textContent = p.name;
    if (p.name === state.current) o.selected = true;
    sel.appendChild(o);
  }
  const p = currentProject();
  if (p) {
    $('region-badge').textContent = p.region;
    $('cloud-badge').textContent = p.cloud || 'aws';
  }
  renderProjectCard();
}

function renderProjectCard() {
  const p = currentProject();
  if (!p) return;
  const cloud = p.cloud || 'aws';
  const cloudEl = $('proj-cloud');
  cloudEl.textContent = cloud === 'gcp' ? 'Google Cloud' : cloud === 'azure' ? 'Azure' : 'AWS';
  cloudEl.className = 'chip ' + cloud;
  $('proj-shape').textContent = p.archetype || (p.siteBucket ? 'static' : '—');

  const st = $('proj-status');
  if (p.status === 'live') { st.className = 'pill live'; st.textContent = 'Live'; }
  else if (p.status === 'provisioned') { st.className = 'pill waiting'; st.textContent = 'provisioned — not live yet'; }
  else if (p.status === 'destroyed') { st.className = 'pill destroyed'; st.textContent = 'destroyed'; }
  else { st.className = 'pill gray'; st.textContent = 'new'; }

  const link = $('live-link');
  const url = p.siteUrl || (p.outputs && (p.outputs.app_url || p.outputs.gateway_url || p.outputs.api_url));
  // ONLY show the URL as live once it's been verified serving (status 'live').
  if (url && p.status === 'live') {
    link.href = url;
    link.textContent = '● ' + url;
    link.classList.remove('hidden');
  } else {
    link.classList.add('hidden');
  }

  // GCP/Azure actuals aren't wired — keep the note honest per cloud.
  $('cost-actual-note').textContent =
    cloud === 'aws'
      ? 'AWS billing can lag ~24 hours.'
      : 'Live billing for ' + (cloud === 'gcp' ? 'GCP' : 'Azure') + " isn't wired yet — ask in chat for a billing lookup.";
}

function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.textContent = text;
  $('chat').appendChild(div);
  $('chat').scrollTop = $('chat').scrollHeight;
  return div;
}

let busy = false;
function setBusy(on) {
  busy = on;
  const input = $('chat-input');
  const indicator = $('busy-indicator');
  // Send stays enabled on purpose — follow-ups are accepted and queued.
  if (on) {
    input.placeholder = "Working… you can still type — I'll queue follow-ups.";
    indicator.classList.remove('hidden');
  } else {
    input.placeholder = 'Ask anything, or say what to deploy — AWS, Google Cloud, or Azure…';
    indicator.classList.add('hidden');
  }
}

let streamingMsg = null;
function appendDelta(text) {
  if (!streamingMsg) streamingMsg = addMsg('assistant', '');
  streamingMsg.textContent += text;
  $('chat').scrollTop = $('chat').scrollHeight;
}

function addBuildLog(line) {
  const log = $('build-log');
  log.classList.remove('hidden');
  const div = document.createElement('div');
  div.textContent = line;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function renderCostEstimate(est) {
  $('cost-estimate').classList.remove('hidden');
  $('cost-monthly').textContent = '$' + est.monthly + '/mo';
  $('cost-daily').textContent = '$' + est.daily;
  $('cost-yearly').textContent = '$' + est.yearly;
  const ul = $('cost-lines');
  ul.innerHTML = '';
  for (const line of est.lines) {
    const li = document.createElement('li');
    const a = document.createElement('span');
    a.textContent = line.item;
    const b = document.createElement('span');
    b.textContent = '$' + line.monthly;
    li.append(a, b);
    ul.appendChild(li);
  }
}

function renderCosts(data) {
  $('cost-total').textContent = '$' + (data.total14d || 0);
  const bars = $('cost-bars');
  bars.innerHTML = '';
  const max = Math.max(1, ...data.dailyCosts.map((d) => d.usd));
  for (const d of data.dailyCosts) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.height = Math.round((d.usd / max) * 100) + '%';
    bar.title = `${d.date}: $${d.usd}`;
    bars.appendChild(bar);
  }
}

const CLOUD_LABEL = { aws: 'AWS', gcp: 'Google Cloud', azure: 'Azure' };

function renderPortfolio(data) {
  const totals = $('portfolio-totals');
  totals.innerHTML = '';
  const grand = document.createElement('div');
  grand.className = 'total-tile grand';
  grand.innerHTML = '<div class="t-label">All clouds</div><div class="t-value">$' + data.totalMonthly + '/mo</div>';
  totals.appendChild(grand);
  for (const [cloud, usd] of Object.entries(data.byCloud)) {
    const tile = document.createElement('div');
    tile.className = 'total-tile';
    tile.innerHTML = '<div class="t-label">' + (CLOUD_LABEL[cloud] || cloud) + '</div><div class="t-value">$' + usd + '/mo</div>';
    totals.appendChild(tile);
  }
  const body = $('portfolio-body');
  body.innerHTML = '';
  for (const r of data.rows) {
    const tr = document.createElement('tr');
    const status = r.status === 'live' ? '<span class="pill live">Live</span>' : r.status === 'provisioned' ? '<span class="pill waiting">provisioned</span>' : '<span class="pill gray">' + r.status + '</span>';
    tr.innerHTML =
      '<td>' + r.name + (r.url ? ' <a href="' + r.url + '" target="_blank" rel="noopener">↗</a>' : '') + '</td>' +
      '<td><span class="chip ' + r.cloud + '">' + (CLOUD_LABEL[r.cloud] || r.cloud) + '</span></td>' +
      '<td>' + (r.archetype || '—') + '</td>' +
      '<td>' + status + '</td>' +
      '<td class="num">$' + r.monthlyEstimate + '</td>';
    body.appendChild(tr);
  }
  if (data.rows.length === 0) {
    body.innerHTML = '<tr><td colspan="5" style="color:var(--muted)">No projects yet — deploy something from the Deploy tab.</td></tr>';
  }
}

function showApproval(action) {
  $('approval-banner').classList.remove('hidden');
  $('approval-summary').textContent = action.summary;
  $('approval-cost').textContent = action.costText || '';
  $('approve-btn').dataset.id = action.id;
  $('reject-btn').dataset.id = action.id;
}
function hideApproval() {
  $('approval-banner').classList.add('hidden');
}

function addActivity(text) {
  const ul = $('activity');
  const li = document.createElement('li');
  li.textContent = text;
  ul.insertBefore(li, ul.firstChild);
  while (ul.children.length > 30) ul.removeChild(ul.lastChild);
}

// ---------- SSE ----------

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    let e;
    try { e = JSON.parse(ev.data); } catch { return; }
    switch (e.type) {
      case 'chat.delta': appendDelta(e.text); break;
      case 'chat.message':
        if (streamingMsg) { streamingMsg = null; } else { addMsg('assistant', e.text); }
        break;
      case 'chat.tool': addMsg('tool', '⚙ ' + e.tool.replace(/_/g, ' ')); addActivity('Tool: ' + e.tool); break;
      case 'chat.done': streamingMsg = null; break;
      case 'chat.busy': setBusy(true); break;
      case 'chat.idle': setBusy(false); break;
      case 'chat.queued': addMsg('tool', "⏳ Queued — I'll get to this right after the current step."); break;
      case 'cost.estimate': renderCostEstimate(e.estimate); break;
      case 'action.pending': showApproval(e.action); addActivity('Approval requested: ' + e.action.type); break;
      case 'action.update': hideApproval(); addActivity('Action ' + e.verdict); break;
      case 'deploy.log': addBuildLog(e.line); break;
      case 'secret.request': openSecretModal(e); break;
      case 'status.update': refreshState(); break;
    }
  };
  es.onerror = () => { /* browser auto-reconnects */ };
}

// ---------- actions ----------

async function refreshState() {
  const s = await api('/api/state');
  state.projects = s.projects;
  state.demo = s.demo;
  if (!state.current && s.projects.length) state.current = s.projects[0].name;
  renderProjects();
  if (s.pendingActions && s.pendingActions.length) showApproval(s.pendingActions[0]);
  if (state.current) {
    const costs = await api('/api/costs/' + state.current);
    renderCosts(costs);
  }
  return s;
}

async function refreshPortfolio() {
  const data = await api('/api/costsummary');
  renderPortfolio(data);
}

let pendingImages = []; // array of data URLs to send with the next message

async function sendChat(text) {
  const images = pendingImages.slice();
  pendingImages = [];
  renderPendingImages();
  addMsg('user', text + (images.length ? `  [📎 ${images.length} image]` : ''));
  const r = await api('/api/chat', { body: { projectName: state.current, text, images } });
  if (r && r.error) addMsg('assistant', '⚠ ' + r.error);
}

function renderPendingImages() {
  const tray = $('image-tray');
  if (!tray) return;
  tray.innerHTML = '';
  tray.classList.toggle('hidden', pendingImages.length === 0);
  pendingImages.forEach((src, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'thumb';
    const img = document.createElement('img');
    img.src = src;
    const x = document.createElement('button');
    x.textContent = '×';
    x.onclick = () => { pendingImages.splice(i, 1); renderPendingImages(); };
    wrap.appendChild(img);
    wrap.appendChild(x);
    tray.appendChild(wrap);
  });
}

function addImageFromFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = () => {
    if (pendingImages.length >= 5) return;
    pendingImages.push(reader.result);
    renderPendingImages();
  };
  reader.readAsDataURL(file);
}

function openSecretModal(e) {
  $('secret-modal').classList.remove('hidden');
  $('secret-name').textContent = e.name;
  $('secret-placeholder').textContent = '{{secret:' + e.name + '}}';
  $('secret-value').value = '';
  $('secret-save').dataset.promptId = e.id;
  $('secret-save').dataset.name = e.name;
  $('secret-value').focus();
}

// ---------- onboarding ----------

let obCloud = 'aws';

function fillRegions(selectEl, cloud) {
  selectEl.innerHTML = '';
  for (const [value, label] of REGIONS[cloud]) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    selectEl.appendChild(o);
  }
}

function renderCloudStates() {
  const c = state.clouds;
  if (!c) return;
  for (const cloud of ['aws', 'gcp', 'azure']) {
    const el = document.querySelector(`.cloud-state[data-for="${cloud}"]`);
    if (!el) continue;
    const info = c[cloud];
    el.textContent = info.connected ? '✓ ' + info.detail : 'not connected';
    el.className = 'cloud-state ' + (info.connected ? 'ok' : 'missing');
  }
  updateCloudHint();
}

function updateCloudHint() {
  const c = state.clouds;
  const hint = $('cloud-hint');
  if (!c) { hint.textContent = ''; return; }
  const info = c[obCloud];
  hint.textContent = info && !info.connected
    ? 'Not connected yet — ' + info.detail + " You can still create the project; I'll walk you through connecting when you deploy."
    : '';
}

async function checkOnboarding() {
  const s = await api('/api/state');
  if (s.config.hasKey) $('ob-key').placeholder = 'Key already saved — leave blank';
  const needsSetup = !s.config.hasKey || s.projects.length === 0;
  if (needsSetup) $('onboarding').classList.remove('hidden');
  api('/api/clouds').then((c) => { state.clouds = c; renderCloudStates(); });
}

// ---------- wire up ----------

function init() {
  connectEvents();
  fillRegions($('ob-region'), 'aws');
  refreshState().then(checkOnboarding);

  // Tabs
  $('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === btn));
    const which = btn.dataset.tab;
    $('tab-deploy').classList.toggle('hidden', which !== 'deploy');
    $('tab-costs').classList.toggle('hidden', which !== 'costs');
    if (which === 'costs') refreshPortfolio();
  });

  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text && pendingImages.length === 0) return;
    input.value = '';
    sendChat(text);
  });

  $('diagnose-btn').addEventListener('click', () => {
    sendChat('Something looks off — run a full diagnosis on this project and explain, in plain English, whether it is healthy and what to fix if not.');
  });

  // Paste a screenshot directly into the chat.
  $('chat-input').addEventListener('paste', (e) => {
    const items = (e.clipboardData || {}).items || [];
    for (const item of items) {
      if (item.type && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) { addImageFromFile(file); e.preventDefault(); }
      }
    }
  });

  // Drag & drop architecture diagrams / files onto the chat.
  const chatCard = document.querySelector('.chat-card');
  ['dragover', 'dragenter'].forEach((ev) =>
    chatCard.addEventListener(ev, (e) => { e.preventDefault(); chatCard.classList.add('drag'); }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    chatCard.addEventListener(ev, (e) => { e.preventDefault(); chatCard.classList.remove('drag'); }),
  );
  chatCard.addEventListener('drop', (e) => {
    const files = (e.dataTransfer || {}).files || [];
    for (const f of files) addImageFromFile(f);
  });

  $('project-select').addEventListener('change', (e) => {
    state.current = e.target.value;
    refreshState();
  });

  $('approve-btn').addEventListener('click', (e) => {
    api('/api/action/' + e.target.dataset.id + '/approved', { body: {} });
    hideApproval();
  });
  $('reject-btn').addEventListener('click', (e) => {
    api('/api/action/' + e.target.dataset.id + '/rejected', { body: {} });
    hideApproval();
  });

  $('secret-save').addEventListener('click', async (e) => {
    const value = $('secret-value').value;
    if (!value) return;
    await api('/api/secret', {
      body: { promptId: e.target.dataset.promptId, projectName: state.current, name: e.target.dataset.name, value },
    });
    $('secret-modal').classList.add('hidden');
    addActivity('Secret stored: ' + e.target.dataset.name);
  });

  // Onboarding cloud picker
  $('cloud-picker').addEventListener('click', (e) => {
    const btn = e.target.closest('.cloud-opt');
    if (!btn) return;
    obCloud = btn.dataset.cloud;
    document.querySelectorAll('.cloud-opt').forEach((b) => b.classList.toggle('active', b === btn));
    fillRegions($('ob-region'), obCloud);
    updateCloudHint();
  });

  $('ob-start').addEventListener('click', async () => {
    const key = $('ob-key').value.trim();
    const name = $('ob-name').value.trim();
    const repoPath = $('ob-path').value.trim();
    const region = $('ob-region').value;
    $('ob-error').classList.add('hidden');
    if (key) await api('/api/config', { body: { anthropicApiKey: key } });
    if (name) {
      // repoPath is OPTIONAL — a project can be for questions or a static site.
      const r = await api('/api/project', { body: { name, repoPath, region, cloud: obCloud } });
      if (r.error) {
        $('ob-error').textContent = r.error;
        $('ob-error').classList.remove('hidden');
        return;
      }
      state.current = name;
    }
    $('onboarding').classList.add('hidden');
    await refreshState();
  });

  $('settings-btn').addEventListener('click', () => $('settings-modal').classList.remove('hidden'));
  $('set-close').addEventListener('click', () => $('settings-modal').classList.add('hidden'));
  $('set-save').addEventListener('click', async () => {
    await api('/api/config', { body: { anthropicApiKey: $('set-key').value.trim(), model: $('set-model').value.trim() } });
    $('settings-modal').classList.add('hidden');
  });
  $('set-newproject').addEventListener('click', async () => {
    const name = $('set-newname').value.trim();
    if (!name) return;
    const cloud = $('set-newcloud').value;
    const r = await api('/api/project', { body: { name, cloud } });
    if (r.error) { alert(r.error); return; }
    state.current = name;
    $('settings-modal').classList.add('hidden');
    await refreshState();
  });
}

init();
