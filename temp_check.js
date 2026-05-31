
// ===== STATE =====
var currentTenantId = null;
var logsPage = 1;
var logsLimit = 20;

// ===== READ BITRIX DATA (safe JSON injection) =====
var bitrixData = JSON.parse(document.getElementById("bitrix-data").textContent);

// ===== AUTH =====
function getToken() { return sessionStorage.getItem("mm_token"); }
function setToken(t) { sessionStorage.setItem("mm_token", t); }
function clearToken() { sessionStorage.removeItem("mm_token"); }

function authHeaders() {
  return { "Authorization": "Bearer " + getToken(), "Content-Type": "application/json" };
}

function api(method, path, body) {
  var opts = { method: method, headers: authHeaders() };
  if (body) opts.body = JSON.stringify(body);
  return fetch(path, opts).then(function(res) {
    if (res.status === 401) { clearToken(); showLogin(); throw new Error("Unauthorized"); }
    if (res.status === 204) return null;
    return res.json().then(function(data) {
      if (!res.ok) throw new Error(data.error || "Request failed");
      return data;
    });
  });
}

function doLogin() {
  var email = document.getElementById("login-email").value.trim();
  var password = document.getElementById("login-password").value;
  var errEl = document.getElementById("login-error");
  errEl.style.display = "none";
  if (!email || !password) { errEl.textContent = "Preencha email e senha"; errEl.style.display = "block"; return; }
  fetch("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: email, password: password })
  }).then(function(res) { return res.json().then(function(d) { return { ok: res.ok, data: d }; }); })
  .then(function(r) {
    if (!r.ok) { errEl.textContent = r.data.error || "Credenciais inv√°lidas"; errEl.style.display = "block"; return; }
    setToken(r.data.token);
    showApp();
  }).catch(function() { errEl.textContent = "Erro de conex√£o"; errEl.style.display = "block"; });
}

function showLogin() {
  document.getElementById("login-screen").style.display = "flex";
  document.getElementById("app-shell").style.display = "none";
}

function showApp() {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("app-shell").style.display = "flex";
  initApp();
}

// ===== INIT =====
function initApp() {
  try {
    var token = getToken();
    var payload = JSON.parse(atob(token.split(".")[1]));
    document.getElementById("footer-user").textContent = payload.email || "";
    api("GET", "/tenants").then(function(tenants) {
      if (tenants && tenants.length > 0) {
        currentTenantId = tenants[0].id;
        document.getElementById("cfg-domain").textContent = tenants[0].bitrix_url || tenants[0].name;
      }
      loadDashboard();
    }).catch(function() { loadDashboard(); });
  } catch (e) {
    try {
      var token2 = getToken();
      var payload2 = JSON.parse(atob(token2.split(".")[1]));
      if (payload2.tenant_id) currentTenantId = payload2.tenant_id;
    } catch(ex) {}
    loadDashboard();
  }
}

// ===== NAVIGATION =====
function navigate(page) {
  document.querySelectorAll(".page").forEach(function(p) { p.classList.remove("active"); });
  document.querySelectorAll(".nav-item").forEach(function(n) { n.classList.remove("active"); });
  var pageEl = document.getElementById("page-" + page);
  var navEl = document.querySelector("[data-page=\"" + page + "\"]");
  if (pageEl) pageEl.classList.add("active");
  if (navEl) navEl.classList.add("active");
  if (page === "dashboard") loadDashboard();
  else if (page === "accounts") loadAccounts();
  else if (page === "logs") { logsPage = 1; loadLogs(); }
  else if (page === "settings") loadSettings();
  else if (page === "plan") loadPlan();
}
// ===== DASHBOARD =====
function loadDashboard() {
  if (!currentTenantId) return;
  api("GET", "/tenants/" + currentTenantId + "/dashboard").then(function(stats) {
    if (stats) {
      document.getElementById("m-today").textContent = stats.today || 0;
      document.getElementById("m-week").textContent = stats.week || 0;
      var total = stats.today || 0;
      var success = stats.success_today || stats.today || 0;
      var rate = total > 0 ? Math.round((success / total) * 100) : 100;
      document.getElementById("m-rate").textContent = rate + "%";
      document.getElementById("m-errors").textContent = stats.errors || 0;
      document.getElementById("m-pending").textContent = stats.pending || 0;
    }
  }).catch(function() {});

  api("GET", "/tenants/" + currentTenantId + "/imap-accounts").then(function(accounts) {
    var activeCount = accounts ? accounts.length : 0;
    document.getElementById("m-accounts").textContent = activeCount;
    document.getElementById("u-accounts").textContent = activeCount + " / 50";
    document.getElementById("st-imap").textContent = activeCount > 0 ? "Conectado (" + activeCount + " contas)" : "Nenhuma conta";
    document.getElementById("sd-imap").style.background = activeCount > 0 ? "#10b981" : "#9ca3af";
  }).catch(function() {});

  api("GET", "/tenants/" + currentTenantId + "/events?limit=5&page=1").then(function(evts) {
    renderRecentActivity(evts.data || evts.events || []);
    var totalProcessed = evts.total || 0;
    document.getElementById("u-emails").textContent = totalProcessed + " / 5.000";
  }).catch(function() {});

  api("GET", "/tenants/" + currentTenantId + "/events?limit=100&page=1").then(function(evts7) {
    renderChart(evts7.data || evts7.events || []);
  }).catch(function() {
    document.getElementById("chart-area").innerHTML = '<div style="text-align:center;color:#9ca3af;padding:40px">Sem dados</div>';
  });

  document.getElementById("st-bitrix").textContent = "Configurado";
  document.getElementById("st-retry").textContent = "Rodando";
}

function renderRecentActivity(events) {
  var el = document.getElementById("recent-activity");
  if (!events || events.length === 0) {
    el.innerHTML = '<div class="empty-state"><p>Nenhum evento registrado ainda</p></div>';
    return;
  }
  el.innerHTML = events.slice(0, 5).map(function(ev) {
    var iconClass = ev.status === "SUCESSO" ? "ic-green" : (ev.status === "ERRO" || ev.status === "FALHA_DEFINITIVA") ? "ic-red" : ev.status === "RECEBIDO" ? "ic-blue" : "ic-yellow";
    var icon = ev.status === "SUCESSO" ? "‚??" : (ev.status === "ERRO" || ev.status === "FALHA_DEFINITIVA") ? "‚??" : "‚?è";
    var time = ev.created_at ? new Date(ev.created_at).toLocaleString("pt-BR", {hour:"2-digit",minute:"2-digit"}) : "";
    return '<div class="activity-item"><div class="ai-icon ' + iconClass + '">' + icon + '</div><div class="ai-text">' + escHtml(ev.from_email || ev.subject || "Email") + '<small>' + escHtml(ev.subject || "") + " ‚?? " + time + '</small></div></div>';
  }).join("");
}
function renderChart(events) {
  var chart = document.getElementById("chart-area");
  var days = [];
  for (var i = 6; i >= 0; i--) {
    var d = new Date(); d.setDate(d.getDate() - i);
    days.push({ date: d.toISOString().slice(0,10), label: d.toLocaleDateString("pt-BR", {weekday:"short"}).slice(0,3), success: 0, error: 0, ignored: 0 });
  }
  (events || []).forEach(function(ev) {
    var evDate = (ev.created_at || "").slice(0,10);
    var day = days.find(function(dd) { return dd.date === evDate; });
    if (!day) return;
    if (ev.status === "SUCESSO") day.success++;
    else if (ev.status === "ERRO" || ev.status === "FALHA_DEFINITIVA") day.error++;
    else day.ignored++;
  });
  var maxVal = Math.max(1, Math.max.apply(null, days.map(function(dd) { return dd.success + dd.error + dd.ignored; })));
  chart.innerHTML = days.map(function(dd) {
    var sh = Math.max(2, (dd.success / maxVal) * 130);
    var eh = Math.max(0, (dd.error / maxVal) * 130);
    var ih = Math.max(0, (dd.ignored / maxVal) * 130);
    var bars = "";
    if (dd.success) bars += '<div class="bar b-success" style="height:' + sh + 'px"></div>';
    if (dd.error) bars += '<div class="bar b-error" style="height:' + eh + 'px"></div>';
    if (dd.ignored) bars += '<div class="bar b-ignored" style="height:' + ih + 'px"></div>';
    if (!dd.success && !dd.error && !dd.ignored) bars += '<div class="bar b-success" style="height:2px;opacity:0.3"></div>';
    return '<div class="bar-group"><div class="bar-stack">' + bars + '</div><div class="bar-label">' + dd.label + '</div></div>';
  }).join("");
}
// ===== ACCOUNTS =====
function loadAccounts() {
  if (!currentTenantId) return;
  var tbody = document.getElementById("accounts-tbody");
  tbody.innerHTML = '<tr><td colspan="7"><div class="loading">Carregando...</div></td></tr>';
  api("GET", "/tenants/" + currentTenantId + "/imap-accounts").then(function(accounts) {
    if (!accounts || accounts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><div class="es-icon">??¨</div><p>Nenhuma conta IMAP configurada</p></div></td></tr>';
      return;
    }
    tbody.innerHTML = accounts.map(function(acc) {
      var statusBadge = acc.active !== false ? '<span class="badge badge-green">Ativo</span>' : '<span class="badge badge-gray">Inativo</span>';
      var lastCheck = acc.last_check_at ? new Date(acc.last_check_at).toLocaleString("pt-BR") : "‚??";
      var mode = (acc.poll_mode || "idle").toUpperCase();
      var toggleLabel = acc.active !== false ? "‚è∏ Pausar" : "‚?∂ Ativar";
      return "<tr>" +
        "<td>" + escHtml(acc.email) + "</td>" +
        "<td>" + escHtml(acc.label || "‚??") + "</td>" +
        "<td>" + escHtml(acc.host) + "</td>" +
        '<td><span class="badge badge-blue">' + mode + "</span></td>" +
        "<td>" + statusBadge + "</td>" +
        "<td>" + lastCheck + "</td>" +
        '<td><button class="btn btn-sm btn-outline btn-toggle" data-id="' + acc.id + '" data-active="' + (acc.active !== false) + '">' + toggleLabel + '</button> <button class="btn btn-sm btn-danger btn-delete" data-id="' + acc.id + '">???</button></td>' +
        "</tr>";
    }).join("");
  }).catch(function() {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><p>Erro ao carregar contas</p></div></td></tr>';
  });
}

function openAddAccountModal() {
  document.getElementById("modal-add-account").classList.add("show");
}

function closeModal() {
  document.getElementById("modal-add-account").classList.remove("show");
}

function createAccount() {
  if (!currentTenantId) { toast("Tenant n√£o configurado", "error"); return; }
  var data = {
    email: document.getElementById("acc-email").value.trim(),
    host: document.getElementById("acc-host").value.trim(),
    port: parseInt(document.getElementById("acc-port").value) || 993,
    username: document.getElementById("acc-username").value.trim(),
    password: document.getElementById("acc-password").value,
    label: document.getElementById("acc-label").value.trim() || undefined,
    poll_mode: document.getElementById("acc-mode").value,
    use_ssl: document.getElementById("acc-ssl").checked
  };
  if (!data.email || !data.host || !data.username || !data.password) {
    toast("Preencha os campos obrigat√≥rios", "error"); return;
  }
  api("POST", "/tenants/" + currentTenantId + "/imap-accounts", data).then(function() {
    toast("Conta adicionada com sucesso!", "success");
    closeModal();
    ["acc-email","acc-host","acc-username","acc-password","acc-label"].forEach(function(id) { document.getElementById(id).value = ""; });
    document.getElementById("acc-port").value = "993";
    loadAccounts();
  }).catch(function(e) { toast(e.message || "Erro ao criar conta", "error"); });
}

function toggleAccount(accountId, currentlyActive) {
  if (!currentTenantId) return;
  api("PATCH", "/tenants/" + currentTenantId + "/imap-accounts/" + accountId + "/toggle", { active: !currentlyActive })
  .then(function() { toast(currentlyActive ? "Conta pausada" : "Conta ativada", "success"); loadAccounts(); })
  .catch(function(e) { toast(e.message || "Erro ao alterar status", "error"); });
}

function deleteAccount(accountId) {
  if (!confirm("Tem certeza que deseja remover esta conta IMAP?")) return;
  if (!currentTenantId) return;
  api("DELETE", "/tenants/" + currentTenantId + "/imap-accounts/" + accountId)
  .then(function() { toast("Conta removida", "success"); loadAccounts(); })
  .catch(function(e) { toast(e.message || "Erro ao remover conta", "error"); });
}
// ===== LOGS =====
function loadLogs() {
  if (!currentTenantId) return;
  var tbody = document.getElementById("logs-tbody");
  tbody.innerHTML = '<tr><td colspan="6"><div class="loading">Carregando...</div></td></tr>';
  var status = document.getElementById("filter-status").value;
  var fromEmail = document.getElementById("filter-from").value.trim();
  var startDate = document.getElementById("filter-start").value;
  var endDate = document.getElementById("filter-end").value;
  var url = "/tenants/" + currentTenantId + "/events?page=" + logsPage + "&limit=" + logsLimit;
  if (status) url += "&status=" + status;
  if (fromEmail) url += "&from_email=" + encodeURIComponent(fromEmail);
  if (startDate) url += "&start_date=" + startDate;
  if (endDate) url += "&end_date=" + endDate;
  api("GET", url).then(function(result) {
    var events = result.data || result.events || [];
    var total = result.total || 0;
    var totalPages = Math.ceil(total / logsLimit) || 1;
    if (events.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><div class="es-icon">???</div><p>Nenhum log encontrado</p></div></td></tr>';
    } else {
      tbody.innerHTML = events.map(function(ev) {
        var date = ev.created_at ? new Date(ev.created_at).toLocaleString("pt-BR") : "‚??";
        var badge = statusBadge(ev.status);
        return "<tr><td>" + date + "</td><td>" + escHtml(ev.from_email || "‚??") + "</td><td>" + escHtml(ev.subject || "‚??") + "</td><td>" + escHtml(ev.account_email || ev.imap_account_id || "‚??") + "</td><td>" + badge + "</td><td>" + (ev.deal_id || "‚??") + "</td></tr>";
      }).join("");
    }
    var pgEl = document.getElementById("logs-pagination");
    pgEl.innerHTML = '<button class="pg-prev" ' + (logsPage <= 1 ? "disabled" : "") + '>‚?ê Anterior</button><span class="pg-info">P√°gina ' + logsPage + " de " + totalPages + '</span><button class="pg-next" ' + (logsPage >= totalPages ? "disabled" : "") + '>Pr√≥xima ‚??</button>';
  }).catch(function() {
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><p>Erro ao carregar logs</p></div></td></tr>';
  });
}

function statusBadge(status) {
  var map = { SUCESSO: "badge-green", ERRO: "badge-red", FALHA_DEFINITIVA: "badge-red", PROCESSANDO: "badge-yellow", DUPLICADO: "badge-gray", IGNORADO: "badge-gray", RECEBIDO: "badge-blue" };
  var cls = map[status] || "badge-gray";
  return '<span class="badge ' + cls + '">' + (status || "‚??") + "</span>";
}
// ===== SETTINGS =====
function loadSettings() {
  if (!currentTenantId) return;
  api("GET", "/tenants").then(function(tenants) {
    var tenant = tenants.find(function(t) { return t.id === currentTenantId; }) || tenants[0];
    if (tenant) {
      document.getElementById("cfg-domain").textContent = tenant.bitrix_url || tenant.name || "‚??";
      document.getElementById("cfg-ignore-from").value = (tenant.ignore_from || []).join("\n");
      document.getElementById("cfg-ignore-subject").value = (tenant.ignore_subject || []).join("\n");
    }
  }).catch(function() {});
}

function saveSettings() {
  if (!currentTenantId) { toast("Tenant n√£o configurado", "error"); return; }
  var ignoreFrom = document.getElementById("cfg-ignore-from").value.split("\n").map(function(s) { return s.trim(); }).filter(Boolean);
  var ignoreSubject = document.getElementById("cfg-ignore-subject").value.split("\n").map(function(s) { return s.trim(); }).filter(Boolean);
  api("PATCH", "/tenants/" + currentTenantId, { ignore_from: ignoreFrom, ignore_subject: ignoreSubject })
  .then(function() { toast("Configura√ß√µes salvas!", "success"); })
  .catch(function(e) { toast(e.message || "Erro ao salvar", "error"); });
}

function testBitrix() {
  if (!currentTenantId) { toast("Tenant n√£o configurado", "error"); return; }
  api("GET", "/tenants").then(function(tenants) {
    var tenant = tenants.find(function(t) { return t.id === currentTenantId; }) || tenants[0];
    if (!tenant) { toast("Tenant n√£o encontrado", "error"); return; }
    return api("POST", "/tenants/test-bitrix", { bitrix_url: tenant.bitrix_url, bitrix_webhook_token: tenant.bitrix_webhook_token });
  }).then(function(result) {
    if (result && result.success) toast("Conex√£o Bitrix OK!", "success");
    else toast("Falha na conex√£o Bitrix", "error");
  }).catch(function(e) { toast(e.message || "Erro ao testar Bitrix", "error"); });
}

function testImap() {
  if (!currentTenantId) { toast("Tenant n√£o configurado", "error"); return; }
  api("GET", "/tenants/" + currentTenantId + "/imap-accounts").then(function(accounts) {
    if (!accounts || accounts.length === 0) { toast("Nenhuma conta IMAP para testar", "error"); return; }
    var acc = accounts[0];
    toast("Testando IMAP (" + acc.host + ")...", "success");
    return api("POST", "/tenants/test-imap", { host: acc.host, port: acc.port || 993, username: acc.username || acc.email, password: "stored", use_ssl: acc.use_ssl !== false });
  }).then(function(result) {
    if (result && result.success) toast("Conex√£o IMAP OK! (" + result.messageCount + " msgs)", "success");
    else if (result) toast("Falha na conex√£o IMAP", "error");
  }).catch(function(e) { toast(e.message || "Erro ao testar IMAP", "error"); });
}
// ===== PLAN =====
function loadPlan() {
  if (!currentTenantId) return;
  api("GET", "/tenants/" + currentTenantId + "/imap-accounts").then(function(accounts) {
    document.getElementById("plan-accounts").textContent = (accounts ? accounts.length : 0) + " / 50";
  }).catch(function() {});
  api("GET", "/tenants/" + currentTenantId + "/events?limit=1&page=1").then(function(evts) {
    var total = evts.total || 0;
    document.getElementById("plan-emails").textContent = total + " / 5.000";
  }).catch(function() {});
}

// ===== UTILS =====
function escHtml(str) {
  if (!str) return "";
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function toast(msg, type) {
  var el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast t-" + (type || "success") + " show";
  setTimeout(function() { el.classList.remove("show"); }, 3000);
}
// ===== EVENT DELEGATION =====
document.addEventListener("click", function(e) {
  // Account toggle button
  var toggleBtn = e.target.closest(".btn-toggle");
  if (toggleBtn) {
    toggleAccount(toggleBtn.dataset.id, toggleBtn.dataset.active === "true");
    return;
  }
  // Account delete button
  var deleteBtn = e.target.closest(".btn-delete");
  if (deleteBtn) {
    deleteAccount(deleteBtn.dataset.id);
    return;
  }
  // Navigation items
  var navItem = e.target.closest(".nav-item");
  if (navItem && navItem.dataset.page) {
    navigate(navItem.dataset.page);
    return;
  }
  // Nav link to logs
  if (e.target.closest(".nav-link-logs")) {
    navigate("logs");
    return;
  }
  // Pagination
  if (e.target.closest(".pg-prev")) {
    logsPage--;
    loadLogs();
    return;
  }
  if (e.target.closest(".pg-next")) {
    logsPage++;
    loadLogs();
    return;
  }
});

// Filter change events
document.getElementById("filter-status").addEventListener("change", function() { loadLogs(); });
document.getElementById("filter-from").addEventListener("change", function() { loadLogs(); });
document.getElementById("filter-start").addEventListener("change", function() { loadLogs(); });
document.getElementById("filter-end").addEventListener("change", function() { loadLogs(); });

// Button bindings
document.getElementById("btn-login").addEventListener("click", doLogin);
document.getElementById("btn-add-account").addEventListener("click", openAddAccountModal);
document.getElementById("btn-cancel-modal").addEventListener("click", closeModal);
document.getElementById("btn-create-account").addEventListener("click", createAccount);
document.getElementById("btn-test-bitrix").addEventListener("click", testBitrix);
document.getElementById("btn-test-imap").addEventListener("click", testImap);
document.getElementById("btn-save-settings").addEventListener("click", saveSettings);

// ===== BOOT =====
// Also try to get DOMAIN from URL params (fallback)
(function() {
  if (!bitrixData.domain) {
    var params = new URLSearchParams(window.location.search);
    bitrixData.domain = params.get("DOMAIN") || params.get("domain") || "";
  }
  if (!bitrixData.member_id) {
    var params2 = new URLSearchParams(window.location.search);
    bitrixData.member_id = params2.get("member_id") || "";
  }
})();

// SKIP LOGIN - go straight to app, auth in background
document.addEventListener("DOMContentLoaded", function() {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("app-shell").style.display = "flex";

  // Try auto-auth in background
  var domain = bitrixData.domain;
  var memberId = bitrixData.member_id;

  if (domain) {
    fetch("/auth/bitrix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain: domain, member_id: memberId || "user", auth_id: bitrixData.auth_id || "" })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.token) {
        setToken(data.token);
        if (data.tenant_id) currentTenantId = data.tenant_id;
      }
      initApp();
    })
    .catch(function() { initApp(); });
  } else if (getToken()) {
    initApp();
  } else {
    // Try BX24 SDK as last resort
    try {
      BX24.init(function() {
        BX24.fitWindow();
        var auth = BX24.getAuth();
        if (auth && auth.domain) {
          fetch("/auth/bitrix", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ domain: auth.domain, member_id: auth.member_id || "user", auth_id: auth.access_token || "" })
          })
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (data.token) {
              setToken(data.token);
              if (data.tenant_id) currentTenantId = data.tenant_id;
            }
            initApp();
          })
          .catch(function() { initApp(); });
        } else {
          initApp();
        }
      });
    } catch(e) {
      initApp();
    }
  }
});

function autoAuth() {}
function fallbackLogin() { initApp(); }

// Init BX24 fitWindow if available
try { BX24.init(function() { BX24.fitWindow(); }); } catch(e) {}

