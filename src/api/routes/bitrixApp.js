/**
 * Bitrix24 Marketplace App endpoints.
 * Full SPA interface served inside Bitrix24 iframe.
 */

export default async function bitrixAppRoutes(fastify) {

  const installHtml = buildInstallHtml();

  fastify.get('/bitrix/app', async (request, reply) => {
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    reply.type('text/html').send(buildAppHtml({}));
  });

  fastify.post('/bitrix/app', async (request, reply) => {
    // Bitrix24 sends auth data via POST form
    const bitrixData = request.body || {};
    request.log.info({ bitrixKeys: Object.keys(bitrixData), domain: bitrixData.DOMAIN, member: bitrixData.member_id }, 'Bitrix24 POST /bitrix/app');
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    reply.type('text/html').send(buildAppHtml(bitrixData));
  });

  fastify.get('/bitrix/install', async (request, reply) => {
    reply.type('text/html').send(installHtml);
  });

  fastify.post('/bitrix/install', async (request, reply) => {
    reply.type('text/html').send(installHtml);
  });

  fastify.get('/bitrix/settings', async (request, reply) => {
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    reply.type('text/html').send(buildAppHtml({}));
  });

  fastify.post('/bitrix/settings', async (request, reply) => {
    const bitrixData = request.body || {};
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    reply.type('text/html').send(buildAppHtml(bitrixData));
  });
}

function buildInstallHtml() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MandaMail - Instalação</title>
  <script src="https://api.bitrix24.com/api/v1/"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0f2f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: white; border-radius: 12px; padding: 48px; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,0.08); max-width: 480px; width: 90%; }
    .icon { font-size: 56px; margin-bottom: 16px; }
    h1 { color: #1a1a2e; font-size: 24px; margin-bottom: 12px; }
    p { color: #6b7280; font-size: 15px; line-height: 1.5; margin-bottom: 24px; }
    .btn { display: inline-block; padding: 14px 32px; background: #3b82f6; color: white; border-radius: 8px; border: none; font-size: 16px; font-weight: 500; cursor: pointer; transition: background 0.2s; }
    .btn:hover { background: #2563eb; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>MandaMail instalado!</h1>
    <p>O app foi instalado com sucesso no seu Bitrix24.<br>Acesse o app para configurar suas contas de email.</p>
    <button class="btn" onclick="BX24.installFinish()">Concluir instalação</button>
    <p style="margin-top:16px;font-size:12px;color:#9ca3af" id="countdown">Redirecionando em 3 segundos...</p>
  </div>
  <script>
    BX24.init(function() {
      BX24.fitWindow();
      var seconds = 3;
      var el = document.getElementById('countdown');
      var timer = setInterval(function() {
        seconds--;
        if (seconds <= 0) {
          clearInterval(timer);
          BX24.installFinish();
        } else {
          el.textContent = 'Redirecionando em ' + seconds + ' segundos...';
        }
      }, 1000);
    });
  </script>
</body>
</html>`;
}


function buildAppHtml(bitrixData) {
  const domain = bitrixData.DOMAIN || bitrixData.domain || '';
  const authId = bitrixData.AUTH_ID || bitrixData.auth_id || '';
  const memberId = bitrixData.member_id || '';
  const appSid = bitrixData.APP_SID || '';
  
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MandaMail</title>
  <script src="https://api.bitrix24.com/api/v1/"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0f2f5; }
    .app { display: flex; min-height: 100vh; }

    /* Login */
    .login-screen { display: flex; justify-content: center; align-items: center; min-height: 100vh; background: #f0f2f5; }
    .login-card { background: white; border-radius: 12px; padding: 40px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); max-width: 400px; width: 90%; text-align: center; }
    .login-card h1 { color: #3b82f6; font-size: 22px; margin-bottom: 8px; }
    .login-card p { color: #6b7280; font-size: 14px; margin-bottom: 24px; }
    .login-card .form-group { margin-bottom: 16px; text-align: left; }
    .login-card label { font-size: 12px; font-weight: 600; color: #374151; display: block; margin-bottom: 4px; }
    .login-card input { width: 100%; padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 14px; }
    .login-card input:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,0.1); }
    .login-card .btn-login { width: 100%; padding: 12px; background: #3b82f6; color: white; border: none; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; margin-top: 8px; }
    .login-card .btn-login:hover { background: #2563eb; }
    .login-card .error-msg { color: #ef4444; font-size: 13px; margin-top: 12px; display: none; }

    /* Sidebar */
    .sidebar { width: 220px; background: #1a1a2e; color: white; padding: 20px 0; display: flex; flex-direction: column; position: fixed; height: 100vh; overflow-y: auto; z-index: 100; }
    .sidebar-brand { padding: 0 20px 24px; border-bottom: 1px solid rgba(255,255,255,0.1); }
    .sidebar-brand h2 { font-size: 16px; color: #3b82f6; font-weight: 700; }
    .sidebar-brand small { color: #9ca3af; font-size: 11px; }
    .sidebar-nav { padding: 16px 0; flex: 1; }
    .nav-item { display: flex; align-items: center; padding: 10px 20px; color: #9ca3af; font-size: 14px; cursor: pointer; transition: all 0.2s; text-decoration: none; border-left: 3px solid transparent; }
    .nav-item:hover { color: white; background: rgba(255,255,255,0.05); }
    .nav-item.active { color: white; background: rgba(59,130,246,0.15); border-left-color: #3b82f6; }
    .nav-item .nav-icon { width: 20px; margin-right: 12px; font-size: 15px; text-align: center; }
    .sidebar-footer { padding: 16px 20px; border-top: 1px solid rgba(255,255,255,0.1); }
    .sidebar-footer small { color: #6b7280; font-size: 11px; }

    /* Main */
    .main { flex: 1; margin-left: 220px; padding: 24px 32px; min-height: 100vh; }
    .page-title { font-size: 22px; font-weight: 600; color: #1a1a2e; margin-bottom: 24px; }

    /* Metrics */
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(155px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .metric-card { background: white; border-radius: 10px; padding: 16px 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
    .metric-card .mc-label { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
    .metric-card .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    .metric-card .mc-value { font-size: 28px; font-weight: 700; color: #1a1a2e; }
    .metric-card .mc-value.clr-green { color: #10b981; }

    /* Status row */
    .status-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .status-card { background: white; border-radius: 10px; padding: 14px 18px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); display: flex; align-items: center; gap: 12px; }
    .status-card .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
    .status-card .s-info h4 { font-size: 13px; color: #1a1a2e; font-weight: 600; }
    .status-card .s-info p { font-size: 12px; color: #6b7280; }

    /* Chart */
    .chart-section { background: white; border-radius: 10px; padding: 24px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); margin-bottom: 24px; }
    .chart-section h3 { font-size: 14px; color: #1a1a2e; margin-bottom: 16px; font-weight: 600; }
    .bar-chart { display: flex; align-items: flex-end; gap: 6px; height: 150px; padding: 0 4px; }
    .bar-group { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; justify-content: flex-end; }
    .bar-stack { display: flex; gap: 2px; align-items: flex-end; width: 100%; justify-content: center; }
    .bar { width: 12px; border-radius: 3px 3px 0 0; min-height: 2px; transition: height 0.3s; }
    .bar.b-success { background: #10b981; }
    .bar.b-error { background: #ef4444; }
    .bar.b-ignored { background: #f59e0b; }
    .bar-label { font-size: 10px; color: #9ca3af; margin-top: 6px; }
    .chart-legend { display: flex; gap: 16px; margin-top: 16px; }
    .chart-legend span { font-size: 12px; color: #6b7280; display: flex; align-items: center; gap: 6px; }
    .chart-legend .ldot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }

    /* Bottom grid */
    .bottom-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .panel { background: white; border-radius: 10px; padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
    .panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .panel-header h3 { font-size: 14px; font-weight: 600; color: #1a1a2e; }
    .panel-header a { font-size: 12px; color: #3b82f6; text-decoration: none; cursor: pointer; }
    .activity-item { display: flex; align-items: center; padding: 10px 0; border-bottom: 1px solid #f3f4f6; }
    .activity-item:last-child { border-bottom: none; }
    .activity-item .ai-icon { width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 12px; font-size: 13px; flex-shrink: 0; }
    .activity-item .ai-icon.ic-green { background: #d1fae5; }
    .activity-item .ai-icon.ic-red { background: #fee2e2; }
    .activity-item .ai-icon.ic-blue { background: #dbeafe; }
    .activity-item .ai-icon.ic-yellow { background: #fef3c7; }
    .activity-item .ai-text { flex: 1; font-size: 13px; color: #374151; line-height: 1.3; }
    .activity-item .ai-text small { display: block; color: #9ca3af; font-size: 11px; margin-top: 2px; }
    .usage-item { display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid #f3f4f6; }
    .usage-item:last-child { border-bottom: none; }
    .usage-item .ul { font-size: 13px; color: #374151; }
    .usage-item .uv { font-size: 13px; color: #6b7280; font-weight: 500; }

    /* Pages */
    .page { display: none; }
    .page.active { display: block; }

    /* Table */
    .table-container { background: white; border-radius: 10px; padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 600px; }
    th { text-align: left; font-size: 11px; color: #6b7280; text-transform: uppercase; padding: 10px 12px; border-bottom: 1px solid #e5e7eb; }
    td { padding: 12px; font-size: 13px; color: #374151; border-bottom: 1px solid #f3f4f6; }
    tr:hover td { background: #f9fafb; }

    /* Badges */
    .badge { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 500; white-space: nowrap; }
    .badge-green { background: #d1fae5; color: #065f46; }
    .badge-red { background: #fee2e2; color: #991b1b; }
    .badge-yellow { background: #fef3c7; color: #92400e; }
    .badge-gray { background: #f3f4f6; color: #6b7280; }
    .badge-blue { background: #dbeafe; color: #1e40af; }

    /* Buttons */
    .btn { padding: 10px 18px; border-radius: 8px; border: none; font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.2s; display: inline-flex; align-items: center; gap: 6px; }
    .btn-primary { background: #3b82f6; color: white; }
    .btn-primary:hover { background: #2563eb; }
    .btn-success { background: #10b981; color: white; }
    .btn-success:hover { background: #059669; }
    .btn-danger { background: #fee2e2; color: #dc2626; border: none; }
    .btn-danger:hover { background: #fecaca; }
    .btn-outline { background: transparent; border: 1px solid #e5e7eb; color: #374151; }
    .btn-outline:hover { background: #f9fafb; }
    .btn-sm { padding: 6px 12px; font-size: 12px; border-radius: 6px; }
    .btn-add { display: inline-flex; align-items: center; gap: 6px; padding: 10px 16px; background: #3b82f6; color: white; border-radius: 8px; border: none; font-size: 13px; font-weight: 500; cursor: pointer; margin-bottom: 16px; }
    .btn-add:hover { background: #2563eb; }

    /* Filters */
    .filters { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; align-items: center; }
    .filters select, .filters input { padding: 8px 12px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 13px; background: white; }
    .filters select:focus, .filters input:focus { outline: none; border-color: #3b82f6; }

    /* Pagination */
    .pagination { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 16px; }
    .pagination button { padding: 6px 14px; border: 1px solid #e5e7eb; background: white; border-radius: 6px; font-size: 13px; cursor: pointer; }
    .pagination button:hover:not(:disabled) { background: #f3f4f6; }
    .pagination button:disabled { opacity: 0.4; cursor: not-allowed; }
    .pagination .pg-info { font-size: 13px; color: #6b7280; }

    /* Modal */
    .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 1000; justify-content: center; align-items: center; }
    .modal-overlay.show { display: flex; }
    .modal { background: white; border-radius: 12px; padding: 32px; max-width: 520px; width: 90%; max-height: 90vh; overflow-y: auto; }
    .modal h2 { font-size: 18px; color: #1a1a2e; margin-bottom: 20px; }
    .modal .form-group { margin-bottom: 14px; }
    .modal label { font-size: 12px; font-weight: 600; color: #374151; display: block; margin-bottom: 4px; }
    .modal input, .modal select { width: 100%; padding: 9px 12px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 13px; }
    .modal input:focus, .modal select:focus { outline: none; border-color: #3b82f6; }
    .modal .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }

    /* Settings */
    .settings-section { background: white; border-radius: 10px; padding: 24px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); margin-bottom: 20px; max-width: 640px; }
    .settings-section h3 { font-size: 15px; font-weight: 600; color: #1a1a2e; margin-bottom: 12px; }
    .settings-section p { font-size: 13px; color: #6b7280; margin-bottom: 16px; line-height: 1.5; }
    .settings-section textarea { width: 100%; height: 90px; padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 13px; resize: vertical; font-family: inherit; }
    .settings-section textarea:focus { outline: none; border-color: #3b82f6; }
    .settings-section .form-group { margin-bottom: 16px; }
    .settings-section .form-group label { font-size: 12px; font-weight: 600; color: #374151; display: block; margin-bottom: 4px; }
    .btn-row { display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap; }

    /* Plan */
    .plan-card { background: white; border-radius: 10px; padding: 32px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); max-width: 500px; }
    .plan-header { text-align: center; margin-bottom: 24px; }
    .plan-header .plan-icon { font-size: 48px; margin-bottom: 12px; }
    .plan-header h2 { color: #1a1a2e; margin-bottom: 8px; font-size: 20px; }
    .plan-header p { color: #6b7280; font-size: 14px; }

    /* Toast */
    .toast { position: fixed; bottom: 24px; right: 24px; padding: 12px 20px; border-radius: 8px; color: white; font-size: 13px; z-index: 2000; opacity: 0; transition: opacity 0.3s; pointer-events: none; }
    .toast.show { opacity: 1; }
    .toast.t-success { background: #10b981; }
    .toast.t-error { background: #ef4444; }

    /* Empty */
    .empty-state { text-align: center; padding: 40px 20px; color: #9ca3af; }
    .empty-state .es-icon { font-size: 40px; margin-bottom: 8px; }
    .empty-state p { font-size: 14px; }

    @media (max-width: 768px) {
      .sidebar { width: 56px; }
      .sidebar-brand h2, .sidebar-brand small, .nav-item span, .sidebar-footer { display: none; }
      .sidebar-brand { padding: 0 10px 16px; }
      .nav-item { padding: 12px 0; justify-content: center; }
      .nav-item .nav-icon { margin-right: 0; }
      .main { margin-left: 56px; padding: 16px; }
      .bottom-grid { grid-template-columns: 1fr; }
      .metrics { grid-template-columns: repeat(2, 1fr); }
      .status-row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>

  <!-- Login Screen -->
  <div id="login-screen" class="login-screen">
    <div class="login-card">
      <h1>MandaMail</h1>
      <p>Faça login para acessar o painel</p>
      <div class="form-group">
        <label>Email</label>
        <input type="email" id="login-email" placeholder="seu@email.com">
      </div>
      <div class="form-group">
        <label>Senha</label>
        <input type="password" id="login-password" placeholder="••••••••">
      </div>
      <button class="btn-login" onclick="doLogin()">Entrar</button>
      <div class="error-msg" id="login-error"></div>
    </div>
  </div>

  <!-- App Shell -->
  <div id="app-shell" class="app" style="display:none">
    <aside class="sidebar">
      <div class="sidebar-brand">
        <h2>MandaMail</h2>
        <small>Email → Bitrix24</small>
      </div>
      <nav class="sidebar-nav">
        <a class="nav-item active" data-page="dashboard" onclick="navigate('dashboard')">
          <span class="nav-icon">📊</span> <span>Painel</span>
        </a>
        <a class="nav-item" data-page="accounts" onclick="navigate('accounts')">
          <span class="nav-icon">📬</span> <span>Contas IMAP</span>
        </a>
        <a class="nav-item" data-page="logs" onclick="navigate('logs')">
          <span class="nav-icon">📋</span> <span>Logs</span>
        </a>
        <a class="nav-item" data-page="settings" onclick="navigate('settings')">
          <span class="nav-icon">⚙️</span> <span>Configurações</span>
        </a>
        <a class="nav-item" data-page="plan" onclick="navigate('plan')">
          <span class="nav-icon">💎</span> <span>Plano</span>
        </a>
      </nav>
      <div class="sidebar-footer">
        <small id="footer-user">—</small>
      </div>
    </aside>

    <main class="main">
      <!-- Dashboard -->
      <div class="page active" id="page-dashboard">
        <h1 class="page-title">Painel de Controle</h1>
        <div class="metrics">
          <div class="metric-card"><div class="mc-label"><span class="dot" style="background:#10b981"></span> EMAILS HOJE</div><div class="mc-value" id="m-today">0</div></div>
          <div class="metric-card"><div class="mc-label"><span class="dot" style="background:#3b82f6"></span> EMAILS NA SEMANA</div><div class="mc-value" id="m-week">0</div></div>
          <div class="metric-card"><div class="mc-label"><span class="dot" style="background:#10b981"></span> TAXA DE SUCESSO</div><div class="mc-value clr-green" id="m-rate">100%</div></div>
          <div class="metric-card"><div class="mc-label"><span class="dot" style="background:#ef4444"></span> EVENTOS COM FALHA</div><div class="mc-value" id="m-errors">0</div></div>
          <div class="metric-card"><div class="mc-label"><span class="dot" style="background:#f59e0b"></span> CARDS PENDENTES</div><div class="mc-value" id="m-pending">0</div></div>
          <div class="metric-card"><div class="mc-label"><span class="dot" style="background:#3b82f6"></span> CONTAS ATIVAS</div><div class="mc-value" id="m-accounts">0</div></div>
        </div>
        <div class="status-row">
          <div class="status-card"><span class="dot" id="sd-imap" style="background:#10b981"></span><div class="s-info"><h4>IMAP</h4><p id="st-imap">Verificando...</p></div></div>
          <div class="status-card"><span class="dot" id="sd-bitrix" style="background:#10b981"></span><div class="s-info"><h4>Bitrix24</h4><p id="st-bitrix">Verificando...</p></div></div>
          <div class="status-card"><span class="dot" style="background:#10b981"></span><div class="s-info"><h4>Plano</h4><p id="st-plan">Ativo</p></div></div>
          <div class="status-card"><span class="dot" id="sd-retry" style="background:#10b981"></span><div class="s-info"><h4>Retry Worker</h4><p id="st-retry">Verificando...</p></div></div>
        </div>
        <div class="chart-section">
          <h3>EVENTOS — ÚLTIMOS 7 DIAS</h3>
          <div class="bar-chart" id="chart-area"></div>
          <div class="chart-legend">
            <span><span class="ldot" style="background:#10b981"></span> Sucesso</span>
            <span><span class="ldot" style="background:#ef4444"></span> Falha</span>
            <span><span class="ldot" style="background:#f59e0b"></span> Ignorado</span>
          </div>
        </div>
        <div class="bottom-grid">
          <div class="panel">
            <div class="panel-header"><h3>ATIVIDADE RECENTE</h3><a onclick="navigate('logs')">Ver tudo</a></div>
            <div id="recent-activity"><div class="empty-state"><p>Carregando...</p></div></div>
          </div>
          <div class="panel">
            <div class="panel-header"><h3>USO DO PLANO</h3></div>
            <div class="usage-item"><span class="ul">Emails processados</span><span class="uv" id="u-emails">0 / 5.000</span></div>
            <div class="usage-item"><span class="ul">Contas IMAP</span><span class="uv" id="u-accounts">0 / 50</span></div>
            <div class="usage-item"><span class="ul">Deals criados</span><span class="uv" id="u-deals">0</span></div>
          </div>
        </div>
      </div>

      <!-- Accounts Page -->
      <div class="page" id="page-accounts">
        <h1 class="page-title">Contas IMAP</h1>
        <button class="btn-add" onclick="openAddAccountModal()">+ Adicionar conta</button>
        <div class="table-container">
          <table>
            <thead><tr><th>Email</th><th>Label</th><th>Servidor</th><th>Modo</th><th>Status</th><th>Último check</th><th>Ações</th></tr></thead>
            <tbody id="accounts-tbody"><tr><td colspan="7"><div class="empty-state"><p>Carregando...</p></div></td></tr></tbody>
          </table>
        </div>
      </div>

      <!-- Logs Page -->
      <div class="page" id="page-logs">
        <h1 class="page-title">Logs de Processamento</h1>
        <div class="filters">
          <select id="filter-status" onchange="loadLogs()">
            <option value="">Todos os status</option>
            <option value="SUCESSO">Sucesso</option>
            <option value="ERRO">Erro</option>
            <option value="PROCESSANDO">Processando</option>
            <option value="DUPLICADO">Duplicado</option>
            <option value="IGNORADO">Ignorado</option>
            <option value="FALHA_DEFINITIVA">Falha Definitiva</option>
            <option value="RECEBIDO">Recebido</option>
          </select>
          <input type="text" id="filter-from" placeholder="Filtrar por remetente..." onchange="loadLogs()">
          <input type="date" id="filter-start" onchange="loadLogs()">
          <input type="date" id="filter-end" onchange="loadLogs()">
        </div>
        <div class="table-container">
          <table>
            <thead><tr><th>Data</th><th>De</th><th>Assunto</th><th>Conta</th><th>Status</th><th>Deal</th></tr></thead>
            <tbody id="logs-tbody"><tr><td colspan="6"><div class="empty-state"><p>Carregando...</p></div></td></tr></tbody>
          </table>
          <div class="pagination" id="logs-pagination"></div>
        </div>
      </div>

      <!-- Settings Page -->
      <div class="page" id="page-settings">
        <h1 class="page-title">Configurações</h1>
        <div class="settings-section">
          <h3>Conexão Bitrix24</h3>
          <p>Portal conectado via OAuth.</p>
          <div class="status-card" style="margin-bottom:16px">
            <span class="dot" style="background:#10b981"></span>
            <div class="s-info"><h4>Conectado</h4><p id="cfg-domain">—</p></div>
          </div>
          <div class="btn-row">
            <button class="btn btn-outline btn-sm" onclick="testBitrix()">🔗 Testar Bitrix</button>
            <button class="btn btn-outline btn-sm" onclick="testImap()">📬 Testar IMAP</button>
          </div>
        </div>
        <div class="settings-section">
          <h3>Filtros de Email</h3>
          <p>Emails desses remetentes ou com esses assuntos serão ignorados automaticamente.</p>
          <div class="form-group">
            <label>Ignorar remetentes (um por linha)</label>
            <textarea id="cfg-ignore-from" placeholder="noreply@example.com"></textarea>
          </div>
          <div class="form-group">
            <label>Ignorar assuntos contendo (um por linha)</label>
            <textarea id="cfg-ignore-subject" placeholder="newsletter"></textarea>
          </div>
          <div class="btn-row">
            <button class="btn btn-primary" onclick="saveSettings()">Salvar configurações</button>
          </div>
        </div>
      </div>

      <!-- Plan Page -->
      <div class="page" id="page-plan">
        <h1 class="page-title">Plano</h1>
        <div class="plan-card">
          <div class="plan-header">
            <div class="plan-icon">💎</div>
            <h2 id="plan-name">Plano Trial</h2>
            <p id="plan-desc">Ativo — uso ilimitado durante o período de teste</p>
          </div>
          <div class="plan-stats">
            <div class="usage-item"><span class="ul">Emails processados (mês)</span><span class="uv" id="plan-emails">0 / 5.000</span></div>
            <div class="usage-item"><span class="ul">Contas IMAP</span><span class="uv" id="plan-accounts">0 / 50</span></div>
            <div class="usage-item"><span class="ul">Deals criados</span><span class="uv" id="plan-deals">0</span></div>
            <div class="usage-item"><span class="ul">Retry automático</span><span class="uv">✅ Incluído</span></div>
            <div class="usage-item"><span class="ul">Alertas SLA</span><span class="uv">✅ Incluído</span></div>
          </div>
        </div>
      </div>
    </main>
  </div>

  <!-- Add Account Modal -->
  <div class="modal-overlay" id="modal-add-account">
    <div class="modal">
      <h2>Adicionar Conta IMAP</h2>
      <div class="form-group"><label>Email *</label><input type="email" id="acc-email" placeholder="conta@empresa.com"></div>
      <div class="form-row">
        <div class="form-group"><label>Host IMAP *</label><input type="text" id="acc-host" placeholder="imap.gmail.com"></div>
        <div class="form-group"><label>Porta</label><input type="number" id="acc-port" placeholder="993" value="993"></div>
      </div>
      <div class="form-group"><label>Usuário *</label><input type="text" id="acc-username" placeholder="conta@empresa.com"></div>
      <div class="form-group"><label>Senha *</label><input type="password" id="acc-password" placeholder="••••••••"></div>
      <div class="form-row">
        <div class="form-group"><label>Label</label><input type="text" id="acc-label" placeholder="Comercial"></div>
        <div class="form-group"><label>Modo</label><select id="acc-mode"><option value="idle">IDLE (tempo real)</option><option value="poll">POLL (intervalo)</option></select></div>
      </div>
      <div class="form-group"><label><input type="checkbox" id="acc-ssl" checked> Usar SSL/TLS</label></div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancelar</button>
        <button class="btn btn-primary" onclick="createAccount()">Adicionar</button>
      </div>
    </div>
  </div>

  <!-- Toast -->
  <div class="toast" id="toast"></div>

  <script>
    // ===== STATE =====
    let currentTenantId = null;
    let logsPage = 1;
    const logsLimit = 20;

    // ===== AUTH =====
    function getToken() { return sessionStorage.getItem('mm_token'); }
    function setToken(t) { sessionStorage.setItem('mm_token', t); }
    function clearToken() { sessionStorage.removeItem('mm_token'); }

    function authHeaders() {
      return { 'Authorization': 'Bearer ' + getToken(), 'Content-Type': 'application/json' };
    }

    async function api(method, path, body) {
      const opts = { method, headers: authHeaders() };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch(path, opts);
      if (res.status === 401) { clearToken(); showLogin(); throw new Error('Unauthorized'); }
      if (res.status === 204) return null;
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      return data;
    }

    async function doLogin() {
      const email = document.getElementById('login-email').value.trim();
      const password = document.getElementById('login-password').value;
      const errEl = document.getElementById('login-error');
      errEl.style.display = 'none';
      if (!email || !password) { errEl.textContent = 'Preencha email e senha'; errEl.style.display = 'block'; return; }
      try {
        const res = await fetch('/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        if (!res.ok) { errEl.textContent = data.error || 'Credenciais inválidas'; errEl.style.display = 'block'; return; }
        setToken(data.token);
        showApp();
      } catch (e) {
        errEl.textContent = 'Erro de conexão'; errEl.style.display = 'block';
      }
    }

    function showLogin() {
      document.getElementById('login-screen').style.display = 'flex';
      document.getElementById('app-shell').style.display = 'none';
    }

    function showApp() {
      document.getElementById('login-screen').style.display = 'none';
      document.getElementById('app-shell').style.display = 'flex';
      initApp();
    }

    // ===== INIT =====
    async function initApp() {
      try {
        // Decode JWT to get tenant info
        const token = getToken();
        const payload = JSON.parse(atob(token.split('.')[1]));
        document.getElementById('footer-user').textContent = payload.email || '';

        // Load tenants to get the first one
        const tenants = await api('GET', '/tenants');
        if (tenants && tenants.length > 0) {
          currentTenantId = tenants[0].id;
          document.getElementById('cfg-domain').textContent = tenants[0].bitrix_url || tenants[0].name;
        }
      } catch (e) {
        // If not admin, try to get tenant from token
        try {
          const token = getToken();
          const payload = JSON.parse(atob(token.split('.')[1]));
          if (payload.tenant_id) currentTenantId = payload.tenant_id;
        } catch(ex) {}
      }
      loadDashboard();
    }

    // ===== NAVIGATION =====
    function navigate(page) {
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      document.getElementById('page-' + page).classList.add('active');
      document.querySelector('[data-page="' + page + '"]').classList.add('active');
      if (page === 'dashboard') loadDashboard();
      else if (page === 'accounts') loadAccounts();
      else if (page === 'logs') { logsPage = 1; loadLogs(); }
      else if (page === 'settings') loadSettings();
      else if (page === 'plan') loadPlan();
    }

    // ===== DASHBOARD =====
    async function loadDashboard() {
      if (!currentTenantId) return;
      try {
        const stats = await api('GET', '/tenants/' + currentTenantId + '/dashboard');
        if (stats) {
          document.getElementById('m-today').textContent = stats.today || 0;
          document.getElementById('m-week').textContent = stats.week || 0;
          const total = (stats.today || 0);
          const success = (stats.success_today || stats.today || 0);
          const rate = total > 0 ? Math.round((success / total) * 100) : 100;
          document.getElementById('m-rate').textContent = rate + '%';
          document.getElementById('m-errors').textContent = stats.errors || 0;
          document.getElementById('m-pending').textContent = stats.pending || 0;
        }
      } catch(e) {}

      // Load accounts count
      try {
        const accounts = await api('GET', '/tenants/' + currentTenantId + '/imap-accounts');
        const activeCount = accounts ? accounts.length : 0;
        document.getElementById('m-accounts').textContent = activeCount;
        document.getElementById('u-accounts').textContent = activeCount + ' / 50';
        document.getElementById('st-imap').textContent = activeCount > 0 ? 'Conectado (' + activeCount + ' contas)' : 'Nenhuma conta';
        document.getElementById('sd-imap').style.background = activeCount > 0 ? '#10b981' : '#9ca3af';
      } catch(e) {}

      // Load recent events for activity feed and chart
      try {
        const evts = await api('GET', '/tenants/' + currentTenantId + '/events?limit=5&page=1');
        renderRecentActivity(evts.data || evts.events || []);
        // Usage stats
        const totalProcessed = evts.total || 0;
        document.getElementById('u-emails').textContent = totalProcessed + ' / 5.000';
      } catch(e) {}

      // Load chart data (last 7 days)
      try {
        const evts7 = await api('GET', '/tenants/' + currentTenantId + '/events?limit=100&page=1');
        renderChart(evts7.data || evts7.events || []);
      } catch(e) {
        document.getElementById('chart-area').innerHTML = '<div style="text-align:center;color:#9ca3af;padding:40px">Sem dados</div>';
      }

      // Status checks
      document.getElementById('st-bitrix').textContent = 'Configurado';
      document.getElementById('st-retry').textContent = 'Rodando';
    }

    function renderRecentActivity(events) {
      const el = document.getElementById('recent-activity');
      if (!events || events.length === 0) {
        el.innerHTML = '<div class="empty-state"><p>Nenhum evento registrado ainda</p></div>';
        return;
      }
      el.innerHTML = events.slice(0, 5).map(ev => {
        const iconClass = ev.status === 'SUCESSO' ? 'ic-green' : ev.status === 'ERRO' || ev.status === 'FALHA_DEFINITIVA' ? 'ic-red' : ev.status === 'RECEBIDO' ? 'ic-blue' : 'ic-yellow';
        const icon = ev.status === 'SUCESSO' ? '✓' : ev.status === 'ERRO' || ev.status === 'FALHA_DEFINITIVA' ? '✗' : '●';
        const time = ev.created_at ? new Date(ev.created_at).toLocaleString('pt-BR', {hour:'2-digit',minute:'2-digit'}) : '';
        return '<div class="activity-item"><div class="ai-icon ' + iconClass + '">' + icon + '</div><div class="ai-text">' + escHtml(ev.from_email || ev.subject || 'Email') + '<small>' + escHtml(ev.subject || '') + ' — ' + time + '</small></div></div>';
      }).join('');
    }

    function renderChart(events) {
      const chart = document.getElementById('chart-area');
      const days = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        days.push({ date: d.toISOString().slice(0,10), label: d.toLocaleDateString('pt-BR', {weekday:'short'}).slice(0,3), success: 0, error: 0, ignored: 0 });
      }
      (events || []).forEach(ev => {
        const evDate = (ev.created_at || '').slice(0,10);
        const day = days.find(d => d.date === evDate);
        if (!day) return;
        if (ev.status === 'SUCESSO') day.success++;
        else if (ev.status === 'ERRO' || ev.status === 'FALHA_DEFINITIVA') day.error++;
        else day.ignored++;
      });
      const maxVal = Math.max(1, ...days.map(d => d.success + d.error + d.ignored));
      chart.innerHTML = days.map(d => {
        const sh = Math.max(2, (d.success / maxVal) * 130);
        const eh = Math.max(0, (d.error / maxVal) * 130);
        const ih = Math.max(0, (d.ignored / maxVal) * 130);
        return '<div class="bar-group"><div class="bar-stack">' +
          (d.success ? '<div class="bar b-success" style="height:' + sh + 'px"></div>' : '') +
          (d.error ? '<div class="bar b-error" style="height:' + eh + 'px"></div>' : '') +
          (d.ignored ? '<div class="bar b-ignored" style="height:' + ih + 'px"></div>' : '') +
          (!d.success && !d.error && !d.ignored ? '<div class="bar b-success" style="height:2px;opacity:0.3"></div>' : '') +
          '</div><div class="bar-label">' + d.label + '</div></div>';
      }).join('');
    }

    // ===== ACCOUNTS =====
    async function loadAccounts() {
      if (!currentTenantId) return;
      const tbody = document.getElementById('accounts-tbody');
      tbody.innerHTML = '<tr><td colspan="7"><div class="loading">Carregando...</div></td></tr>';
      try {
        const accounts = await api('GET', '/tenants/' + currentTenantId + '/imap-accounts');
        if (!accounts || accounts.length === 0) {
          tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><div class="es-icon">📬</div><p>Nenhuma conta IMAP configurada</p></div></td></tr>';
          return;
        }
        tbody.innerHTML = accounts.map(acc => {
          const statusBadge = acc.active !== false ? '<span class="badge badge-green">Ativo</span>' : '<span class="badge badge-gray">Inativo</span>';
          const lastCheck = acc.last_check_at ? new Date(acc.last_check_at).toLocaleString('pt-BR') : '—';
          const mode = (acc.poll_mode || 'idle').toUpperCase();
          return '<tr>' +
            '<td>' + escHtml(acc.email) + '</td>' +
            '<td>' + escHtml(acc.label || '—') + '</td>' +
            '<td>' + escHtml(acc.host) + '</td>' +
            '<td><span class="badge badge-blue">' + mode + '</span></td>' +
            '<td>' + statusBadge + '</td>' +
            '<td>' + lastCheck + '</td>' +
            '<td><button class="btn btn-sm btn-outline" onclick="toggleAccount(\'' + acc.id + '\',' + (acc.active !== false) + ')">' + (acc.active !== false ? '⏸ Pausar' : '▶ Ativar') + '</button> <button class="btn btn-sm btn-danger" onclick="deleteAccount(\'' + acc.id + '\')">🗑</button></td>' +
            '</tr>';
        }).join('');
      } catch(e) {
        tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><p>Erro ao carregar contas</p></div></td></tr>';
      }
    }

    function openAddAccountModal() {
      document.getElementById('modal-add-account').classList.add('show');
    }

    function closeModal() {
      document.getElementById('modal-add-account').classList.remove('show');
    }

    async function createAccount() {
      if (!currentTenantId) { toast('Tenant não configurado', 'error'); return; }
      const data = {
        email: document.getElementById('acc-email').value.trim(),
        host: document.getElementById('acc-host').value.trim(),
        port: parseInt(document.getElementById('acc-port').value) || 993,
        username: document.getElementById('acc-username').value.trim(),
        password: document.getElementById('acc-password').value,
        label: document.getElementById('acc-label').value.trim() || undefined,
        poll_mode: document.getElementById('acc-mode').value,
        use_ssl: document.getElementById('acc-ssl').checked
      };
      if (!data.email || !data.host || !data.username || !data.password) {
        toast('Preencha os campos obrigatórios', 'error'); return;
      }
      try {
        await api('POST', '/tenants/' + currentTenantId + '/imap-accounts', data);
        toast('Conta adicionada com sucesso!', 'success');
        closeModal();
        // Clear form
        ['acc-email','acc-host','acc-username','acc-password','acc-label'].forEach(id => document.getElementById(id).value = '');
        document.getElementById('acc-port').value = '993';
        loadAccounts();
      } catch(e) {
        toast(e.message || 'Erro ao criar conta', 'error');
      }
    }

    async function toggleAccount(accountId, currentlyActive) {
      if (!currentTenantId) return;
      try {
        await api('PATCH', '/tenants/' + currentTenantId + '/imap-accounts/' + accountId + '/toggle', { active: !currentlyActive });
        toast(currentlyActive ? 'Conta pausada' : 'Conta ativada', 'success');
        loadAccounts();
      } catch(e) {
        toast(e.message || 'Erro ao alterar status', 'error');
      }
    }

    async function deleteAccount(accountId) {
      if (!confirm('Tem certeza que deseja remover esta conta IMAP?')) return;
      if (!currentTenantId) return;
      try {
        await api('DELETE', '/tenants/' + currentTenantId + '/imap-accounts/' + accountId);
        toast('Conta removida', 'success');
        loadAccounts();
      } catch(e) {
        toast(e.message || 'Erro ao remover conta', 'error');
      }
    }

    // ===== LOGS =====
    async function loadLogs() {
      if (!currentTenantId) return;
      const tbody = document.getElementById('logs-tbody');
      tbody.innerHTML = '<tr><td colspan="6"><div class="loading">Carregando...</div></td></tr>';

      const status = document.getElementById('filter-status').value;
      const fromEmail = document.getElementById('filter-from').value.trim();
      const startDate = document.getElementById('filter-start').value;
      const endDate = document.getElementById('filter-end').value;

      let url = '/tenants/' + currentTenantId + '/events?page=' + logsPage + '&limit=' + logsLimit;
      if (status) url += '&status=' + status;
      if (fromEmail) url += '&from_email=' + encodeURIComponent(fromEmail);
      if (startDate) url += '&start_date=' + startDate;
      if (endDate) url += '&end_date=' + endDate;

      try {
        const result = await api('GET', url);
        const events = result.data || result.events || [];
        const total = result.total || 0;
        const totalPages = Math.ceil(total / logsLimit) || 1;

        if (events.length === 0) {
          tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><div class="es-icon">📋</div><p>Nenhum log encontrado</p></div></td></tr>';
        } else {
          tbody.innerHTML = events.map(ev => {
            const date = ev.created_at ? new Date(ev.created_at).toLocaleString('pt-BR') : '—';
            const badge = statusBadge(ev.status);
            return '<tr><td>' + date + '</td><td>' + escHtml(ev.from_email || '—') + '</td><td>' + escHtml(ev.subject || '—') + '</td><td>' + escHtml(ev.account_email || ev.imap_account_id || '—') + '</td><td>' + badge + '</td><td>' + (ev.deal_id || '—') + '</td></tr>';
          }).join('');
        }

        // Pagination
        const pgEl = document.getElementById('logs-pagination');
        pgEl.innerHTML = '<button ' + (logsPage <= 1 ? 'disabled' : '') + ' onclick="logsPage--;loadLogs()">← Anterior</button><span class="pg-info">Página ' + logsPage + ' de ' + totalPages + '</span><button ' + (logsPage >= totalPages ? 'disabled' : '') + ' onclick="logsPage++;loadLogs()">Próxima →</button>';
      } catch(e) {
        tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><p>Erro ao carregar logs</p></div></td></tr>';
      }
    }

    function statusBadge(status) {
      const map = { SUCESSO: 'badge-green', ERRO: 'badge-red', FALHA_DEFINITIVA: 'badge-red', PROCESSANDO: 'badge-yellow', DUPLICADO: 'badge-gray', IGNORADO: 'badge-gray', RECEBIDO: 'badge-blue' };
      const cls = map[status] || 'badge-gray';
      return '<span class="badge ' + cls + '">' + (status || '—') + '</span>';
    }

    // ===== SETTINGS =====
    async function loadSettings() {
      if (!currentTenantId) return;
      try {
        const tenants = await api('GET', '/tenants');
        const tenant = tenants.find(t => t.id === currentTenantId) || tenants[0];
        if (tenant) {
          document.getElementById('cfg-domain').textContent = tenant.bitrix_url || tenant.name || '—';
          document.getElementById('cfg-ignore-from').value = (tenant.ignore_from || []).join('\\n');
          document.getElementById('cfg-ignore-subject').value = (tenant.ignore_subject || []).join('\\n');
        }
      } catch(e) {}
    }

    async function saveSettings() {
      if (!currentTenantId) { toast('Tenant não configurado', 'error'); return; }
      const ignoreFrom = document.getElementById('cfg-ignore-from').value.split('\\n').map(s => s.trim()).filter(Boolean);
      const ignoreSubject = document.getElementById('cfg-ignore-subject').value.split('\\n').map(s => s.trim()).filter(Boolean);
      try {
        await api('PATCH', '/tenants/' + currentTenantId, { ignore_from: ignoreFrom, ignore_subject: ignoreSubject });
        toast('Configurações salvas!', 'success');
      } catch(e) {
        toast(e.message || 'Erro ao salvar', 'error');
      }
    }

    async function testBitrix() {
      if (!currentTenantId) { toast('Tenant não configurado', 'error'); return; }
      try {
        const tenants = await api('GET', '/tenants');
        const tenant = tenants.find(t => t.id === currentTenantId) || tenants[0];
        if (!tenant) { toast('Tenant não encontrado', 'error'); return; }
        const result = await api('POST', '/tenants/test-bitrix', { bitrix_url: tenant.bitrix_url, bitrix_webhook_token: tenant.bitrix_webhook_token });
        if (result.success) toast('Conexão Bitrix OK!', 'success');
        else toast('Falha na conexão Bitrix', 'error');
      } catch(e) {
        toast(e.message || 'Erro ao testar Bitrix', 'error');
      }
    }

    async function testImap() {
      if (!currentTenantId) { toast('Tenant não configurado', 'error'); return; }
      try {
        const accounts = await api('GET', '/tenants/' + currentTenantId + '/imap-accounts');
        if (!accounts || accounts.length === 0) { toast('Nenhuma conta IMAP para testar', 'error'); return; }
        const acc = accounts[0];
        toast('Testando IMAP (' + acc.host + ')...', 'success');
        const result = await api('POST', '/tenants/test-imap', { host: acc.host, port: acc.port || 993, username: acc.username || acc.email, password: 'stored', use_ssl: acc.use_ssl !== false });
        if (result.success) toast('Conexão IMAP OK! (' + result.messageCount + ' msgs)', 'success');
        else toast('Falha na conexão IMAP', 'error');
      } catch(e) {
        toast(e.message || 'Erro ao testar IMAP', 'error');
      }
    }

    // ===== PLAN =====
    async function loadPlan() {
      if (!currentTenantId) return;
      try {
        const accounts = await api('GET', '/tenants/' + currentTenantId + '/imap-accounts');
        document.getElementById('plan-accounts').textContent = (accounts ? accounts.length : 0) + ' / 50';
      } catch(e) {}
      try {
        const evts = await api('GET', '/tenants/' + currentTenantId + '/events?limit=1&page=1');
        const total = evts.total || 0;
        document.getElementById('plan-emails').textContent = total + ' / 5.000';
      } catch(e) {}
    }

    // ===== UTILS =====
    function escHtml(str) {
      if (!str) return '';
      return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function toast(msg, type) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.className = 'toast t-' + (type || 'success') + ' show';
      setTimeout(() => { el.classList.remove('show'); }, 3000);
    }

    // ===== BOOT =====
    // Bitrix24 data injected from server POST
    var BX_DOMAIN = '${domain}';
    var BX_AUTH_ID = '${authId}';
    var BX_MEMBER_ID = '${memberId}';

    document.addEventListener('DOMContentLoaded', function() {
      // If we have Bitrix data from POST, auto-authenticate immediately
      if (BX_DOMAIN && BX_MEMBER_ID) {
        autoAuth(BX_DOMAIN, BX_MEMBER_ID, BX_AUTH_ID);
        return;
      }

      // Try BX24 JS SDK
      try {
        BX24.init(function() {
          BX24.fitWindow();
          // Try getAuth first
          var auth = BX24.getAuth();
          if (auth && auth.domain) {
            autoAuth(auth.domain, auth.member_id || 'user', auth.access_token || '');
            return;
          }
          // Try getting domain from BX24.getDomain()
          var domain = '';
          try { domain = BX24.getDomain(); } catch(e) {}
          if (domain) {
            autoAuth(domain, 'user', '');
            return;
          }
          // Last resort: check URL params (some Bitrix versions pass via query)
          var params = new URLSearchParams(window.location.search);
          var qDomain = params.get('DOMAIN') || params.get('domain');
          if (qDomain) {
            autoAuth(qDomain, params.get('member_id') || 'user', params.get('AUTH_ID') || '');
            return;
          }
          fallbackLogin();
        });
      } catch(e) {
        fallbackLogin();
      }
    });

    function autoAuth(domain, memberId, authId) {
      fetch('/auth/bitrix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domain, member_id: memberId || 'user', auth_id: authId || '' })
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.token) {
          setToken(data.token);
          if (data.tenant_id) currentTenantId = data.tenant_id;
          showApp();
        } else {
          fallbackLogin();
        }
      })
      .catch(function() { fallbackLogin(); });
    }

    function fallbackLogin() {
      if (getToken()) {
        showApp();
      } else {
        showLogin();
      }
    }

    // Init BX24 fitWindow if available
    try { BX24.init(function() { BX24.fitWindow(); }); } catch(e) {}
  </script>
</body>
</html>`;
}
