/**
 * Bitrix24 Marketplace App endpoints.
 * Full SPA interface served inside Bitrix24 iframe.
 */

export default async function bitrixAppRoutes(fastify) {

  const appHtml = buildAppHtml();

  // GET and POST for all Bitrix iframe endpoints
  fastify.get('/bitrix/app', async (request, reply) => {
    reply.type('text/html').send(appHtml);
  });

  fastify.post('/bitrix/app', async (request, reply) => {
    reply.type('text/html').send(appHtml);
  });

  fastify.get('/bitrix/install', async (request, reply) => {
    reply.type('text/html').send(buildInstallHtml());
  });

  fastify.post('/bitrix/install', async (request, reply) => {
    reply.type('text/html').send(buildInstallHtml());
  });

  fastify.get('/bitrix/settings', async (request, reply) => {
    reply.type('text/html').send(appHtml);
  });

  fastify.post('/bitrix/settings', async (request, reply) => {
    reply.type('text/html').send(appHtml);
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
  </div>
  <script>BX24.init(function() { BX24.fitWindow(); });</script>
</body>
</html>`;
}

function buildAppHtml() {
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
    
    /* Layout */
    .app { display: flex; min-height: 100vh; }
    
    /* Sidebar */
    .sidebar { width: 220px; background: #1a1a2e; color: white; padding: 20px 0; display: flex; flex-direction: column; position: fixed; height: 100vh; overflow-y: auto; }
    .sidebar-brand { padding: 0 20px 24px; border-bottom: 1px solid rgba(255,255,255,0.1); }
    .sidebar-brand h2 { font-size: 16px; color: #3b82f6; font-weight: 700; }
    .sidebar-brand small { color: #9ca3af; font-size: 11px; }
    .sidebar-nav { padding: 16px 0; flex: 1; }
    .nav-item { display: flex; align-items: center; padding: 10px 20px; color: #9ca3af; font-size: 14px; cursor: pointer; transition: all 0.2s; text-decoration: none; }
    .nav-item:hover { color: white; background: rgba(255,255,255,0.05); }
    .nav-item.active { color: white; background: rgba(59,130,246,0.15); border-left: 3px solid #3b82f6; }
    .nav-item svg, .nav-item .icon { width: 18px; margin-right: 12px; font-size: 16px; }
    .sidebar-footer { padding: 16px 20px; border-top: 1px solid rgba(255,255,255,0.1); }
    .sidebar-footer select { width: 100%; background: rgba(255,255,255,0.1); border: none; color: white; padding: 8px; border-radius: 4px; font-size: 12px; }
    
    /* Main content */
    .main { flex: 1; margin-left: 220px; padding: 24px 32px; }
    .page-title { font-size: 22px; font-weight: 600; color: #1a1a2e; margin-bottom: 24px; }
    
    /* Metric cards */
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .metric-card { background: white; border-radius: 10px; padding: 16px 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
    .metric-card .label { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
    .metric-card .label .dot { width: 8px; height: 8px; border-radius: 50%; }
    .metric-card .label .dot.green { background: #10b981; }
    .metric-card .label .dot.blue { background: #3b82f6; }
    .metric-card .label .dot.red { background: #ef4444; }
    .metric-card .label .dot.yellow { background: #f59e0b; }
    .metric-card .value { font-size: 28px; font-weight: 700; color: #1a1a2e; }
    .metric-card .value.success { color: #10b981; }
    .metric-card .sub { font-size: 11px; color: #9ca3af; margin-top: 2px; }
    
    /* Status cards row */
    .status-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .status-card { background: white; border-radius: 10px; padding: 16px 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); display: flex; align-items: center; gap: 12px; }
    .status-card .dot { width: 10px; height: 10px; border-radius: 50%; }
    .status-card .dot.green { background: #10b981; }
    .status-card .dot.gray { background: #9ca3af; }
    .status-card .info h4 { font-size: 13px; color: #1a1a2e; font-weight: 600; }
    .status-card .info p { font-size: 12px; color: #6b7280; }
    
    /* Chart area */
    .chart-section { background: white; border-radius: 10px; padding: 24px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); margin-bottom: 24px; }
    .chart-section h3 { font-size: 14px; color: #1a1a2e; margin-bottom: 16px; font-weight: 600; }
    .chart-placeholder { height: 180px; display: flex; align-items: center; justify-content: center; color: #9ca3af; font-size: 14px; border: 1px dashed #e5e7eb; border-radius: 8px; }
    .chart-legend { display: flex; gap: 16px; margin-top: 12px; }
    .chart-legend span { font-size: 12px; color: #6b7280; display: flex; align-items: center; gap: 6px; }
    .chart-legend .dot { width: 8px; height: 8px; border-radius: 50%; }
    
    /* Bottom grid */
    .bottom-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .panel { background: white; border-radius: 10px; padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
    .panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .panel-header h3 { font-size: 14px; font-weight: 600; color: #1a1a2e; }
    .panel-header a { font-size: 12px; color: #3b82f6; text-decoration: none; }
    .activity-item { display: flex; align-items: center; padding: 10px 0; border-bottom: 1px solid #f3f4f6; }
    .activity-item:last-child { border-bottom: none; }
    .activity-item .icon { width: 32px; height: 32px; border-radius: 50%; background: #eff6ff; display: flex; align-items: center; justify-content: center; margin-right: 12px; font-size: 14px; }
    .activity-item .text { flex: 1; font-size: 13px; color: #374151; }
    .activity-item .time { font-size: 11px; color: #9ca3af; }
    .usage-item { display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid #f3f4f6; }
    .usage-item:last-child { border-bottom: none; }
    .usage-item .label { font-size: 13px; color: #374151; }
    .usage-item .value { font-size: 13px; color: #6b7280; }
    
    /* Pages */
    .page { display: none; }
    .page.active { display: block; }
    
    /* IMAP accounts page */
    .table-container { background: white; border-radius: 10px; padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-size: 11px; color: #6b7280; text-transform: uppercase; padding: 10px 12px; border-bottom: 1px solid #e5e7eb; }
    td { padding: 12px; font-size: 13px; color: #374151; border-bottom: 1px solid #f3f4f6; }
    .badge { display: inline-block; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 500; }
    .badge.green { background: #d1fae5; color: #065f46; }
    .badge.red { background: #fee2e2; color: #991b1b; }
    .badge.yellow { background: #fef3c7; color: #92400e; }
    .badge.gray { background: #f3f4f6; color: #6b7280; }
    .btn-sm { padding: 6px 12px; border-radius: 6px; border: none; font-size: 12px; cursor: pointer; }
    .btn-primary { background: #3b82f6; color: white; }
    .btn-primary:hover { background: #2563eb; }
    .btn-danger { background: #fee2e2; color: #dc2626; }
    .btn-add { display: inline-flex; align-items: center; gap: 6px; padding: 10px 16px; background: #3b82f6; color: white; border-radius: 8px; border: none; font-size: 13px; cursor: pointer; margin-bottom: 16px; }
    .btn-add:hover { background: #2563eb; }
    
    /* Empty state */
    .empty-state { text-align: center; padding: 48px 20px; color: #9ca3af; }
    .empty-state .icon { font-size: 48px; margin-bottom: 12px; }
    .empty-state p { font-size: 14px; }
    
    /* Loading */
    .loading { text-align: center; padding: 40px; color: #6b7280; }
    
    @media (max-width: 768px) {
      .sidebar { width: 60px; }
      .sidebar-brand h2, .sidebar-brand small, .nav-item span, .sidebar-footer { display: none; }
      .main { margin-left: 60px; padding: 16px; }
      .bottom-grid { grid-template-columns: 1fr; }
      .metrics { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <div class="app">
    <!-- Sidebar -->
    <aside class="sidebar">
      <div class="sidebar-brand">
        <h2>MandaMail</h2>
        <small>Email → Bitrix24</small>
      </div>
      <nav class="sidebar-nav">
        <a class="nav-item active" data-page="dashboard" onclick="showPage('dashboard')">
          <span class="icon">📊</span> <span>Painel</span>
        </a>
        <a class="nav-item" data-page="accounts" onclick="showPage('accounts')">
          <span class="icon">📬</span> <span>Contas IMAP</span>
        </a>
        <a class="nav-item" data-page="logs" onclick="showPage('logs')">
          <span class="icon">📋</span> <span>Logs</span>
        </a>
        <a class="nav-item" data-page="settings" onclick="showPage('settings')">
          <span class="icon">⚙️</span> <span>Configurações</span>
        </a>
        <a class="nav-item" data-page="plan" onclick="showPage('plan')">
          <span class="icon">💎</span> <span>Plano</span>
        </a>
      </nav>
      <div class="sidebar-footer">
        <select>
          <option>🇧🇷 Português</option>
        </select>
      </div>
    </aside>

    <!-- Main Content -->
    <main class="main">
      <!-- Dashboard Page -->
      <div class="page active" id="page-dashboard">
        <h1 class="page-title">Painel de Controle</h1>
        
        <div class="metrics">
          <div class="metric-card">
            <div class="label"><span class="dot green"></span> EMAILS HOJE</div>
            <div class="value" id="stat-today">0</div>
          </div>
          <div class="metric-card">
            <div class="label"><span class="dot blue"></span> EMAILS NA SEMANA</div>
            <div class="value" id="stat-week">0</div>
          </div>
          <div class="metric-card">
            <div class="label"><span class="dot green"></span> TAXA DE SUCESSO</div>
            <div class="value success" id="stat-rate">100%</div>
          </div>
          <div class="metric-card">
            <div class="label"><span class="dot red"></span> EVENTOS COM FALHA</div>
            <div class="value" id="stat-errors">0</div>
          </div>
          <div class="metric-card">
            <div class="label"><span class="dot yellow"></span> CARDS PENDENTES</div>
            <div class="value" id="stat-pending">0</div>
          </div>
          <div class="metric-card">
            <div class="label"><span class="dot blue"></span> CONTAS ATIVAS</div>
            <div class="value" id="stat-accounts">0</div>
          </div>
        </div>
        
        <div class="status-row">
          <div class="status-card">
            <span class="dot green"></span>
            <div class="info"><h4>IMAP</h4><p id="imap-status">Conectado</p></div>
          </div>
          <div class="status-card">
            <span class="dot green"></span>
            <div class="info"><h4>Bitrix24</h4><p id="bitrix-status">Configurado</p></div>
          </div>
          <div class="status-card">
            <span class="dot green"></span>
            <div class="info"><h4>Plano</h4><p>Ativo</p></div>
          </div>
          <div class="status-card">
            <span class="dot green"></span>
            <div class="info"><h4>Retry Worker</h4><p>Rodando</p></div>
          </div>
        </div>
        
        <div class="chart-section">
          <h3>EVENTOS — ÚLTIMOS 7 DIAS</h3>
          <div class="chart-placeholder" id="chart-area">Carregando dados...</div>
          <div class="chart-legend">
            <span><span class="dot" style="background:#10b981"></span> Sucesso</span>
            <span><span class="dot" style="background:#ef4444"></span> Falha</span>
            <span><span class="dot" style="background:#f59e0b"></span> Ignorado</span>
          </div>
        </div>
        
        <div class="bottom-grid">
          <div class="panel">
            <div class="panel-header">
              <h3>ATIVIDADE RECENTE</h3>
              <a href="#" onclick="showPage('logs')">Ver tudo</a>
            </div>
            <div id="recent-activity">
              <div class="empty-state"><p>Nenhum evento registrado ainda</p></div>
            </div>
          </div>
          <div class="panel">
            <div class="panel-header">
              <h3>USO DO PLANO</h3>
            </div>
            <div class="usage-item">
              <span class="label">Emails processados</span>
              <span class="value" id="usage-emails">0 / 5.000 (0%)</span>
            </div>
            <div class="usage-item">
              <span class="label">Contas IMAP</span>
              <span class="value" id="usage-accounts">0 / 50 (0%)</span>
            </div>
            <div class="usage-item">
              <span class="label">Deals criados</span>
              <span class="value" id="usage-deals">0</span>
            </div>
          </div>
        </div>
      </div>

      <!-- IMAP Accounts Page -->
      <div class="page" id="page-accounts">
        <h1 class="page-title">Contas IMAP</h1>
        <button class="btn-add" onclick="showAddAccount()">+ Adicionar conta</button>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Label</th>
                <th>Servidor</th>
                <th>Modo</th>
                <th>Status</th>
                <th>Último check</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody id="accounts-table">
              <tr><td colspan="7" class="empty-state"><p>Nenhuma conta IMAP configurada</p></td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Logs Page -->
      <div class="page" id="page-logs">
        <h1 class="page-title">Logs de Processamento</h1>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Data</th>
                <th>De</th>
                <th>Assunto</th>
                <th>Conta</th>
                <th>Status</th>
                <th>Deal</th>
              </tr>
            </thead>
            <tbody id="logs-table">
              <tr><td colspan="6" class="empty-state"><p>Nenhum email processado ainda</p></td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Settings Page -->
      <div class="page" id="page-settings">
        <h1 class="page-title">Configurações</h1>
        <div class="panel" style="max-width:600px">
          <h3 style="margin-bottom:16px">Conexão Bitrix24</h3>
          <p style="font-size:13px;color:#6b7280;margin-bottom:16px">O app se conecta automaticamente ao seu Bitrix24 via OAuth. Nenhuma configuração manual necessária.</p>
          <div class="status-card" style="margin-bottom:16px">
            <span class="dot green"></span>
            <div class="info"><h4>Conectado</h4><p id="settings-domain">Seu portal Bitrix24</p></div>
          </div>
          <h3 style="margin:24px 0 12px">Filtros de Email</h3>
          <p style="font-size:13px;color:#6b7280;margin-bottom:12px">Emails desses remetentes ou com esses assuntos serão ignorados automaticamente.</p>
          <div style="margin-bottom:12px">
            <label style="font-size:12px;font-weight:600;color:#374151">Ignorar remetentes (um por linha)</label>
            <textarea id="ignore-from" style="width:100%;height:80px;margin-top:4px;padding:8px;border:1px solid #e5e7eb;border-radius:6px;font-size:13px;resize:vertical" placeholder="noreply@example.com"></textarea>
          </div>
          <div>
            <label style="font-size:12px;font-weight:600;color:#374151">Ignorar assuntos contendo (um por linha)</label>
            <textarea id="ignore-subject" style="width:100%;height:80px;margin-top:4px;padding:8px;border:1px solid #e5e7eb;border-radius:6px;font-size:13px;resize:vertical" placeholder="newsletter"></textarea>
          </div>
        </div>
      </div>

      <!-- Plan Page -->
      <div class="page" id="page-plan">
        <h1 class="page-title">Plano</h1>
        <div class="panel" style="max-width:500px">
          <div style="text-align:center;padding:20px">
            <div style="font-size:48px;margin-bottom:12px">💎</div>
            <h2 style="color:#1a1a2e;margin-bottom:8px">Plano Trial</h2>
            <p style="color:#6b7280;font-size:14px">Ativo — uso ilimitado durante o período de teste</p>
          </div>
          <div class="usage-item">
            <span class="label">Emails/mês</span>
            <span class="value">5.000</span>
          </div>
          <div class="usage-item">
            <span class="label">Contas IMAP</span>
            <span class="value">50</span>
          </div>
          <div class="usage-item">
            <span class="label">Retry automático</span>
            <span class="value">✅ Incluído</span>
          </div>
          <div class="usage-item">
            <span class="label">Alertas SLA</span>
            <span class="value">✅ Incluído</span>
          </div>
        </div>
      </div>
    </main>
  </div>

  <script>
    // Navigation
    function showPage(page) {
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      document.getElementById('page-' + page).classList.add('active');
      document.querySelector('[data-page="' + page + '"]').classList.add('active');
    }

    function showAddAccount() {
      alert('Funcionalidade em desenvolvimento. Use a API REST para adicionar contas IMAP.');
    }

    // Initialize Bitrix24 JS SDK
    BX24.init(function() {
      BX24.fitWindow();
    });
  </script>
</body>
</html>`;
}
