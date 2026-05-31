/**
 * Bitrix24 Marketplace App endpoints.
 * These are called by Bitrix24 when the app is installed/opened/configured.
 */

export default async function bitrixAppRoutes(fastify) {
  // Application URL - main app page (loaded in iframe inside Bitrix24)
  fastify.get('/bitrix/app', async (request, reply) => {
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>MandaMail - Email to Bitrix24</title>
  <script src="https://api.bitrix24.com/api/v1/"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
    .container { max-width: 800px; margin: 0 auto; background: white; border-radius: 8px; padding: 30px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    h1 { color: #333; margin-bottom: 10px; }
    .subtitle { color: #666; margin-bottom: 30px; }
    .status { padding: 15px; border-radius: 6px; margin-bottom: 15px; }
    .status.ok { background: #e8f5e9; color: #2e7d32; }
    .status.info { background: #e3f2fd; color: #1565c0; }
    .feature { display: flex; align-items: center; padding: 12px 0; border-bottom: 1px solid #eee; }
    .feature-icon { font-size: 24px; margin-right: 15px; }
    .feature-text h3 { margin: 0 0 4px 0; color: #333; }
    .feature-text p { margin: 0; color: #666; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>📧 MandaMail</h1>
    <p class="subtitle">Transforme emails em deals automaticamente</p>
    
    <div class="status ok">✅ App instalado e funcionando</div>
    <div class="status info">ℹ️ Configure suas contas IMAP nas configurações do app</div>
    
    <h2>Funcionalidades</h2>
    <div class="feature">
      <span class="feature-icon">📬</span>
      <div class="feature-text">
        <h3>Monitoramento IMAP em tempo real</h3>
        <p>Monitora múltiplas caixas de email via IDLE ou polling</p>
      </div>
    </div>
    <div class="feature">
      <span class="feature-icon">🤝</span>
      <div class="feature-text">
        <h3>Criação automática de deals</h3>
        <p>Cada email vira um deal com contato vinculado</p>
      </div>
    </div>
    <div class="feature">
      <span class="feature-icon">🔄</span>
      <div class="feature-text">
        <h3>Retry automático</h3>
        <p>Backoff exponencial: 2, 5, 15, 30, 60 minutos</p>
      </div>
    </div>
    <div class="feature">
      <span class="feature-icon">🚨</span>
      <div class="feature-text">
        <h3>Alertas de SLA</h3>
        <p>Notificação por email, webhook ou Slack quando emails travam</p>
      </div>
    </div>
    <div class="feature">
      <span class="feature-icon">📊</span>
      <div class="feature-text">
        <h3>Dashboard completo</h3>
        <p>Métricas em tempo real de todos os emails processados</p>
      </div>
    </div>
  </div>
  <script>
    BX24.init(function() {
      BX24.fitWindow();
    });
  </script>
</body>
</html>`;
    reply.type('text/html').send(html);
  });

  // Application installer URL - called when app is installed
  fastify.get('/bitrix/install', async (request, reply) => {
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Instalando MandaMail...</title>
  <script src="https://api.bitrix24.com/api/v1/"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 40px; display: flex; justify-content: center; align-items: center; min-height: 80vh; background: #f5f5f5; }
    .card { background: white; border-radius: 8px; padding: 40px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.1); max-width: 500px; }
    h1 { color: #333; }
    p { color: #666; }
    .success { color: #2e7d32; font-size: 48px; }
    .btn { display: inline-block; margin-top: 20px; padding: 12px 24px; background: #2196F3; color: white; border-radius: 6px; text-decoration: none; cursor: pointer; border: none; font-size: 16px; }
    .btn:hover { background: #1976D2; }
  </style>
</head>
<body>
  <div class="card">
    <div class="success">✅</div>
    <h1>MandaMail instalado!</h1>
    <p>O app foi instalado com sucesso no seu Bitrix24.</p>
    <p>Acesse as configurações para adicionar suas contas de email IMAP.</p>
    <button class="btn" onclick="BX24.installFinish()">Concluir instalação</button>
  </div>
  <script>
    BX24.init(function() {
      // App installed successfully
      BX24.fitWindow();
    });
  </script>
</body>
</html>`;
    reply.type('text/html').send(html);
  });

  // Application settings handler - settings page (iframe)
  fastify.get('/bitrix/settings', async (request, reply) => {
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>MandaMail - Configurações</title>
  <script src="https://api.bitrix24.com/api/v1/"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
    .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 8px; padding: 30px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    h1 { color: #333; margin-bottom: 20px; }
    .info { background: #e3f2fd; padding: 15px; border-radius: 6px; margin-bottom: 20px; color: #1565c0; }
    .field { margin-bottom: 15px; }
    .field label { display: block; font-weight: 600; margin-bottom: 5px; color: #333; }
    .field input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; box-sizing: border-box; }
    .btn { padding: 12px 24px; background: #2196F3; color: white; border-radius: 6px; border: none; font-size: 16px; cursor: pointer; }
    .btn:hover { background: #1976D2; }
    #status { margin-top: 15px; padding: 10px; border-radius: 4px; display: none; }
    #status.success { display: block; background: #e8f5e9; color: #2e7d32; }
    #status.error { display: block; background: #ffebee; color: #c62828; }
  </style>
</head>
<body>
  <div class="container">
    <h1>⚙️ Configurações MandaMail</h1>
    <div class="info">
      Configure o painel de administração em: <strong>https://mandamail.manda4.com.br</strong><br>
      Use a API REST para gerenciar tenants e contas IMAP.
    </div>
    <p>Para configurar o monitoramento de emails:</p>
    <ol>
      <li>Acesse o painel admin: <a href="https://mandamail.manda4.com.br" target="_blank">mandamail.manda4.com.br</a></li>
      <li>Faça login com suas credenciais</li>
      <li>Cadastre o tenant com a URL do seu Bitrix24</li>
      <li>Adicione as contas IMAP que deseja monitorar</li>
    </ol>
    <div id="status"></div>
  </div>
  <script>
    BX24.init(function() {
      BX24.fitWindow();
    });
  </script>
</body>
</html>`;
    reply.type('text/html').send(html);
  });

  // POST handlers (Bitrix sends POST with form data when opening in iframe)
  fastify.post('/bitrix/app', async (request, reply) => {
    // Bitrix sends PLACEMENT, AUTH_ID, etc. via POST
    return fastify.inject({ method: 'GET', url: '/bitrix/app' }).then(res => {
      reply.type('text/html').send(res.body);
    });
  });

  fastify.post('/bitrix/install', async (request, reply) => {
    return fastify.inject({ method: 'GET', url: '/bitrix/install' }).then(res => {
      reply.type('text/html').send(res.body);
    });
  });

  fastify.post('/bitrix/settings', async (request, reply) => {
    return fastify.inject({ method: 'GET', url: '/bitrix/settings' }).then(res => {
      reply.type('text/html').send(res.body);
    });
  });
}
