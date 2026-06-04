# Requirements Document

## Introduction

Este documento define os requisitos para a funcionalidade de planos de assinatura do MandaMail. O sistema deve exibir uma página de planos para o usuário (tenant) com cards de preços e botão de assinatura, verificar se o tenant possui um plano ativo (ou trial) antes de processar emails no pipeline, e integrar com o Stripe para checkout e gerenciamento de assinaturas.

A infraestrutura de backend (tabelas de planos, cupons, subscriptions, rotas admin, integração Stripe com checkout/webhook/portal) já está implementada. Os requisitos aqui cobrem as funcionalidades pendentes voltadas ao usuário final.

## Glossary

- **Sistema**: A aplicação MandaMail como um todo (API + pipeline + frontend)
- **Página_de_Planos**: Tela dentro do app Bitrix que exibe os planos disponíveis para assinatura
- **Pipeline**: O EmailPipeline que processa emails recebidos via IMAP e cria deals no Bitrix24
- **Tenant**: Uma organização/empresa que utiliza o MandaMail (identificada por bitrix_url)
- **Subscription**: Registro de assinatura de um tenant a um plano, com status e período de validade
- **Plano**: Configuração de limites e preços (mensal/anual) disponível para assinatura
- **Trial**: Período de teste gratuito concedido a novos tenants antes de exigir assinatura paga
- **Stripe_Checkout**: Sessão de pagamento hospedada pelo Stripe para processar assinaturas
- **Stripe_Portal**: Portal de autoatendimento do Stripe para gerenciar assinatura existente
- **Verificador_de_Plano**: Componente que valida se o tenant possui assinatura ativa antes de processar emails
- **Cupom**: Código de desconto aplicável durante o checkout

## Requirements

### Requirement 1: Listagem de Planos Disponíveis

**User Story:** Como um tenant, eu quero ver os planos disponíveis com preços e limites, para que eu possa escolher o plano mais adequado para minha empresa.

#### Acceptance Criteria

1. WHEN o tenant acessa a Página_de_Planos, THE Sistema SHALL exibir todos os planos ativos em formato de cards ordenados por email_limit crescente
2. THE Página_de_Planos SHALL exibir para cada plano: nome, descrição, preço mensal, preço anual, limite de emails e limite de contas IMAP
3. THE Página_de_Planos SHALL exibir os preços em Reais (BRL) no formato brasileiro (R$ X.XXX,XX) convertendo os valores armazenados em centavos para reais com duas casas decimais
4. WHILE o tenant possui uma Subscription com status "active" ou "trial", THE Página_de_Planos SHALL exibir um indicador "Plano Atual" no card do plano correspondente à Subscription do tenant
5. THE Página_de_Planos SHALL permitir alternar a visualização entre preços mensais e anuais, exibindo preços mensais como visualização padrão ao carregar a página
6. IF não existem planos com status active no sistema, THEN THE Página_de_Planos SHALL exibir uma mensagem informando que não há planos disponíveis no momento

### Requirement 2: Fluxo de Assinatura via Stripe Checkout

**User Story:** Como um tenant, eu quero assinar um plano clicando em um botão de "Assinar", para que eu possa ativar o serviço de processamento de emails.

#### Acceptance Criteria

1. WHEN o tenant clica no botão "Assinar" de um plano, THE Sistema SHALL criar uma sessão de Stripe_Checkout com o price_id correspondente ao ciclo de cobrança selecionado (mensal ou anual), incluindo o tenant_id, plan_id e billing_cycle nos metadados da sessão
2. WHEN o tenant informa um código de Cupom válido (código existente, ativo, com current_uses menor que max_uses quando definido, e data atual dentro do intervalo valid_from/valid_until quando definidos), THE Sistema SHALL aplicar o desconto na sessão de Stripe_Checkout e registrar o coupon_id nos metadados da sessão
3. IF o tenant informa um código de Cupom que não existe, está inativo, excedeu o limite de usos ou está fora do período de validade, THEN THE Sistema SHALL exibir uma mensagem de erro informando que o cupom não é válido, sem bloquear o fluxo de checkout (o tenant pode prosseguir sem cupom)
4. WHEN a sessão de Stripe_Checkout é criada com sucesso, THE Sistema SHALL redirecionar o tenant para a URL de checkout do Stripe em até 3 segundos após o clique
5. WHEN o pagamento é concluído com sucesso no Stripe, THE Sistema SHALL redirecionar o tenant de volta à Página_de_Planos com o parâmetro checkout=success na URL
6. IF a criação da sessão de Stripe_Checkout falha por erro na API do Stripe ou por dados inválidos (plano inexistente, plano inativo, ou tenant inexistente), THEN THE Sistema SHALL exibir uma mensagem de erro indicando que não foi possível iniciar o checkout e manter o tenant na Página_de_Planos
7. IF o tenant cancela o pagamento na página do Stripe, THEN THE Sistema SHALL redirecionar o tenant de volta à Página_de_Planos com o parâmetro checkout=cancel na URL, sem criar nenhuma Subscription

### Requirement 3: Ativação de Assinatura via Webhook

**User Story:** Como o sistema, eu quero processar eventos do Stripe automaticamente, para que as assinaturas sejam ativadas sem intervenção manual.

#### Acceptance Criteria

1. WHEN o evento checkout.session.completed é recebido do Stripe com tenant_id e plan_id nos metadados, THE Sistema SHALL criar ou atualizar o registro de Subscription do tenant com status "active", armazenando stripe_subscription_id, stripe_customer_id, plan_id, billing_cycle, current_period_start e current_period_end
2. WHEN o evento checkout.session.completed contém um coupon_id nos metadados, THE Sistema SHALL incrementar o campo current_uses do Cupom correspondente em 1
3. WHEN o evento customer.subscription.updated é recebido com status "past_due", THE Sistema SHALL atualizar o status da Subscription correspondente ao stripe_subscription_id para "past_due"
4. WHEN o evento customer.subscription.updated é recebido com status "active", THE Sistema SHALL atualizar o status da Subscription correspondente ao stripe_subscription_id para "active"
5. WHEN o evento customer.subscription.deleted é recebido, THE Sistema SHALL atualizar o status da Subscription correspondente ao stripe_subscription_id para "canceled" e registrar a data atual no campo canceled_at
6. WHEN o evento invoice.payment_failed é recebido com um subscription ID, THE Sistema SHALL atualizar o status da Subscription correspondente ao stripe_subscription_id para "past_due"
7. IF a assinatura do webhook não puder ser verificada via stripe-signature, THEN THE Sistema SHALL rejeitar a requisição com código HTTP 400 e não processar o evento
8. IF o evento recebido não contém tenant_id nos metadados ou o stripe_subscription_id não corresponde a nenhuma Subscription existente, THEN THE Sistema SHALL registrar um log de aviso e retornar HTTP 200 sem alterar dados
9. WHEN um evento é processado com sucesso, THE Sistema SHALL retornar HTTP 200 em no máximo 5 segundos para evitar timeout do Stripe

### Requirement 4: Verificação de Plano Ativo no Pipeline

**User Story:** Como o sistema, eu quero bloquear o processamento de emails para tenants sem plano ativo, para que apenas clientes pagantes utilizem o serviço.

#### Acceptance Criteria

1. WHEN um email é recebido para processamento, THE Verificador_de_Plano SHALL consultar a Subscription do tenant antes de executar qualquer outro passo do Pipeline (antes da deduplicação e filtros)
2. WHILE a Subscription do tenant possui status "active" e current_period_end é posterior à data atual, THE Pipeline SHALL prosseguir com o processamento do email nos passos subsequentes (deduplicação, filtros, integração Bitrix)
3. WHILE a Subscription do tenant possui status "trial" e trial_ends_at é posterior à data atual, THE Pipeline SHALL prosseguir com o processamento do email nos passos subsequentes (deduplicação, filtros, integração Bitrix)
4. IF a Subscription do tenant possui status "canceled", "expired" ou não existe registro de Subscription para o tenant, THEN THE Pipeline SHALL rejeitar o email, definir o status do email_event como "PLANO_INATIVO" e registrar no log o tenant_id e o motivo da rejeição
5. IF a Subscription do tenant possui status "past_due" e a data atual é igual ou anterior a current_period_end + 7 dias corridos, THEN THE Pipeline SHALL prosseguir com o processamento do email normalmente
6. IF a Subscription do tenant possui status "past_due" e a data atual é posterior a current_period_end + 7 dias corridos, THEN THE Pipeline SHALL rejeitar o email, definir o status do email_event como "PLANO_INATIVO" e registrar no log o tenant_id e o motivo da rejeição
7. IF a consulta à Subscription falha por erro de banco de dados ou timeout (máximo 5 segundos), THEN THE Pipeline SHALL rejeitar o email com status "ERRO" e agendar retry conforme mecanismo existente de retentativas
8. WHEN o email é rejeitado por plano inativo, THE Pipeline SHALL criar o registro email_event com status "PLANO_INATIVO" sem executar os passos de deduplicação, filtros ou integração Bitrix

### Requirement 5: Verificação de Plano no TenantScheduler

**User Story:** Como o sistema, eu quero parar os workers IMAP de tenants sem plano ativo, para que recursos do servidor não sejam consumidos por clientes inativos.

#### Acceptance Criteria

1. WHEN o TenantScheduler inicia todos os workers, THE Sistema SHALL consultar a Subscription de cada tenant e iniciar apenas workers de tenants cuja Subscription possui status "active" com current_period_end posterior à data atual, ou status "trial" com trial_ends_at posterior à data atual
2. WHEN a Subscription de um tenant muda para status "canceled" ou "expired" via webhook do Stripe, THE Sistema SHALL parar todos os workers IMAP daquele tenant em até 30 segundos após o recebimento do evento
3. WHEN a Subscription de um tenant muda para status "active" via webhook do Stripe, THE Sistema SHALL iniciar os workers IMAP de todas as contas IMAP ativas daquele tenant em até 30 segundos após o recebimento do evento
4. IF um tenant não possui registro de Subscription, THEN THE Sistema SHALL tratar como plano inativo e não iniciar workers IMAP para aquele tenant
5. WHILE a Subscription de um tenant possui status "past_due", THE Sistema SHALL manter os workers IMAP em execução durante um período de carência de 7 dias após current_period_end, e parar os workers após esse período
6. WHEN o TenantScheduler para os workers de um tenant por inatividade de plano, THE Sistema SHALL registrar no log o tenant_id, o motivo da parada e a quantidade de workers encerrados

### Requirement 6: Gerenciamento de Assinatura pelo Tenant

**User Story:** Como um tenant com assinatura ativa, eu quero gerenciar minha assinatura (trocar plano, atualizar cartão, cancelar), para que eu tenha controle sobre minha conta.

#### Acceptance Criteria

1. WHILE o tenant possui uma Subscription com status "active" ou "past_due", THE Página_de_Planos SHALL exibir um botão "Gerenciar Assinatura"
2. WHEN o tenant clica em "Gerenciar Assinatura", THE Sistema SHALL criar uma sessão do Stripe_Portal e redirecionar o tenant para a URL retornada em até 5 segundos
3. IF a criação da sessão do Stripe_Portal falha (customer não encontrado ou erro de comunicação com Stripe), THEN THE Sistema SHALL exibir uma mensagem de erro indicando que não foi possível acessar o portal e manter o tenant na Página_de_Planos
4. WHILE o tenant não possui Subscription ou possui Subscription com status "canceled" ou "expired", THE Página_de_Planos SHALL ocultar o botão "Gerenciar Assinatura"
5. THE Página_de_Planos SHALL exibir o status atual da assinatura do tenant utilizando os rótulos: "Ativo", "Trial", "Expirado", "Inadimplente" ou "Sem assinatura" quando não houver registro de Subscription
6. WHILE o tenant está em período de trial, THE Página_de_Planos SHALL exibir a data de expiração do trial no formato "dd/mm/aaaa"

### Requirement 7: Provisão de Trial para Novos Tenants

**User Story:** Como um novo tenant, eu quero ter um período de trial ao me cadastrar, para que eu possa testar o sistema antes de pagar.

#### Acceptance Criteria

1. WHEN um novo tenant é criado no sistema, THE Sistema SHALL criar automaticamente uma Subscription com status "trial", plan_id NULL, e trial_ends_at configurado para 14 dias após a criação
2. IF o tenant já possui uma Subscription existente (ex: reinstalação do app Bitrix24), THEN THE Sistema SHALL manter a Subscription existente sem criar uma nova
3. WHILE o tenant está em período de trial (status "trial" e trial_ends_at posterior à data atual), THE Pipeline SHALL processar emails respeitando os limites padrão de 5000 emails e 50 contas IMAP
4. WHEN o Pipeline ou o TenantScheduler verifica a Subscription de um tenant com status "trial" e trial_ends_at anterior à data atual, THE Sistema SHALL atualizar o status da Subscription para "expired"
5. WHILE a Subscription do tenant possui status "expired" e não possui stripe_subscription_id, THE Página_de_Planos SHALL exibir uma mensagem informando que o trial expirou e que é necessário assinar um plano
6. IF o tenant assina um plano durante o trial, THEN THE Sistema SHALL atualizar a Subscription existente para status "active" com stripe_subscription_id, stripe_customer_id, current_period_start e current_period_end recebidos do Stripe

### Requirement 8: Endpoint de Status da Assinatura

**User Story:** Como o frontend do app Bitrix, eu quero consultar o status da assinatura do tenant, para que eu possa exibir as informações corretas na interface.

#### Acceptance Criteria

1. THE Sistema SHALL disponibilizar um endpoint GET /subscriptions/status que aceita o tenant_id como parâmetro de query e retorna o status da assinatura do tenant em formato JSON com código HTTP 200
2. WHEN o tenant possui uma Subscription associada a um plano, THE endpoint SHALL retornar: status da assinatura (um dos valores: "trial", "active", "canceled", "past_due", "expired"), nome do plano, ciclo de cobrança ("monthly" ou "yearly"), data de início do período atual (ISO 8601), data de fim do período atual (ISO 8601), e data de expiração do trial (ISO 8601) quando o status for "trial" ou null caso contrário
3. WHEN o tenant não possui Subscription, THE endpoint SHALL retornar código HTTP 200 com status "none" e os demais campos de plano como null
4. IF a requisição não contém autenticação válida, THEN THE Sistema SHALL rejeitar com código HTTP 401 e um corpo JSON contendo uma mensagem de erro
5. IF o tenant_id informado não existe ou o usuário autenticado não possui acesso ao tenant, THEN THE Sistema SHALL rejeitar com código HTTP 403
6. THE endpoint SHALL responder em no máximo 2 segundos sob condições normais de operação
