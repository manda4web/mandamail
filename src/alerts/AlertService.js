import { db } from '../db/client.js';
import { EmailEventRepo } from '../db/repos/EmailEventRepo.js';
import { AlertConfigRepo } from '../db/repos/AlertConfigRepo.js';
import * as ImapAccountRepo from '../db/repos/ImapAccountRepo.js';
import logger from '../logger.js';

// An account whose worker hasn't updated last_poll_at for this long is
// considered silent. In idle mode the heartbeat runs every 30s and in poll
// mode every poll_interval_sec (<=3600s), so 15 min is comfortably beyond any
// healthy cycle plus reconnection backoff, avoiding false positives.
const SILENT_ACCOUNT_MINUTES = Number(process.env.SILENT_ACCOUNT_MINUTES ?? 15);

export class AlertService {
  constructor(checkIntervalSec = 60) {
    this.checkIntervalSec = checkIntervalSec;
    this.intervalId = null;
    this.lastAlertTimes = new Map(); // eventId:status -> timestamp
    this.lastSilentAlertTimes = new Map(); // accountId -> timestamp
  }

  start() {
    // .catch on the interval promise so an async rejection can never escape as
    // a process-wide unhandled rejection.
    this.intervalId = setInterval(
      () => this.checkAll().catch(err => logger.error(`[AlertService] tick error: ${err.message}`)),
      this.checkIntervalSec * 1000
    );
    this.checkAll().catch(err => logger.error(`[AlertService] initial run error: ${err.message}`));
    logger.info(`[AlertService] started — checking every ${this.checkIntervalSec}s`);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    logger.info('[AlertService] stopped');
  }

  async checkAll() {
    try {
      const { rows: tenants } = await db.query('SELECT id FROM tenants WHERE active = true');
      for (const { id } of tenants) {
        await this._checkTenant(id);
      }
    } catch (err) {
      logger.error(`[AlertService] error: ${err.message}`);
    }

    // Silent-account detection runs independently of stuck-event detection:
    // a dead worker produces NO email_events, so findStuck would never see it.
    // This is the "an account stopped and nobody noticed" detector.
    try {
      await this._checkSilentAccounts();
    } catch (err) {
      logger.error(`[AlertService] silent-account check error: ${err.message}`);
    }
  }

  /**
   * Alerts when an active account's worker has gone silent (last_poll_at stale).
   * Uses the tenant's existing alert_configs for delivery, deduped per account
   * within the silence window so it doesn't spam every cycle.
   */
  async _checkSilentAccounts() {
    const silent = await ImapAccountRepo.findSilent(SILENT_ACCOUNT_MINUTES);
    if (silent.length === 0) return;

    // Group silent accounts by tenant so each tenant is alerted via its own configs.
    const byTenant = new Map();
    for (const acc of silent) {
      if (!byTenant.has(acc.tenant_id)) byTenant.set(acc.tenant_id, []);
      byTenant.get(acc.tenant_id).push(acc);
    }

    for (const [tenantId, accounts] of byTenant) {
      let alertConfigs;
      try {
        alertConfigs = await AlertConfigRepo.findByTenant(tenantId);
      } catch (err) {
        logger.error(`[AlertService] could not load alert configs for tenant ${tenantId}: ${err.message}`);
        continue;
      }
      if (!alertConfigs || alertConfigs.length === 0) {
        // No delivery channel configured — still surface it in the logs so an
        // operator watching logs/metrics can see the account went silent.
        for (const acc of accounts) {
          logger.warn(`[AlertService] SILENT ACCOUNT ${acc.email} (tenant ${tenantId}) — no poll since ${acc.last_poll_at || 'never'} | lastError=${acc.last_error || '-'}`);
        }
        continue;
      }

      // Dedup per account within the silence window.
      const toAlert = accounts.filter(acc => {
        const last = this.lastSilentAlertTimes.get(acc.id);
        if (!last) return true;
        return (Date.now() - last) >= SILENT_ACCOUNT_MINUTES * 60_000;
      });
      if (toAlert.length === 0) continue;

      // Record the dedup timestamp BEFORE delivery. Delivery can take up to
      // ~90s per config (3 attempts × 30s backoff), while the AlertService
      // ticks every 60s — writing the timestamp afterwards would let a second
      // tick re-alert the same account before the first pass finished. Marking
      // upfront makes the dedup window authoritative.
      for (const acc of toAlert) {
        this.lastSilentAlertTimes.set(acc.id, Date.now());
        logger.warn(`[AlertService] SILENT ACCOUNT ${acc.email} (tenant ${tenantId}) — no poll since ${acc.last_poll_at || 'never'} | lastError=${acc.last_error || '-'}`);
      }

      for (const alert of alertConfigs) {
        let sent = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await this._sendSilentAlert(alert, toAlert);
            sent = true;
            break;
          } catch (err) {
            logger.error(`[AlertService] silent-account delivery attempt ${attempt} failed: ${err.message}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 30_000));
          }
        }
        if (!sent) {
          logger.error(`[AlertService] failed to deliver silent-account alert ${alert.id} after 3 attempts`);
        }
      }
    }
  }

  /**
   * Delivers a silent-account alert through the same channels as stuck-event
   * alerts. Shapes a distinct payload/message so operators can tell them apart.
   */
  async _sendSilentAlert(alert, accounts) {
    const summary = accounts.map(a =>
      `${a.email}${a.label ? ` (${a.label})` : ''} — sem coleta desde ${a.last_poll_at ? new Date(a.last_poll_at).toISOString() : 'sempre'}${a.last_error ? ` | erro: ${a.last_error}` : ''}`
    );

    if (alert.alert_type === 'WEBHOOK') {
      const res = await fetch(alert.destination, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alert: 'accounts_silent',
          threshold_min: SILENT_ACCOUNT_MINUTES,
          count: accounts.length,
          accounts: accounts.map(a => ({
            id: a.id, email: a.email, label: a.label,
            last_poll_at: a.last_poll_at, last_error: a.last_error,
          })),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`webhook responded HTTP ${res.status}`);
    } else if (alert.alert_type === 'SLACK') {
      const res = await fetch(alert.destination, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `:rotating_light: *${accounts.length} conta(s) IMAP sem coletar email* há mais de ${SILENT_ACCOUNT_MINUTES}min:\n${summary.map(s => `• ${s}`).join('\n')}`,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`slack webhook responded HTTP ${res.status}`);
    } else if (alert.alert_type === 'EMAIL') {
      const { createTransport } = await import('nodemailer');
      const transporter = createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT ?? 587),
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
      });
      await transporter.sendMail({
        from: process.env.SMTP_FROM,
        to: alert.destination,
        subject: `[Alerta] ${accounts.length} conta(s) IMAP sem coletar email`,
        text: `As seguintes contas não coletam email há mais de ${SILENT_ACCOUNT_MINUTES} minutos. Verifique conexão/credenciais:\n\n${summary.join('\n')}`,
      });
    }
  }

  async _checkTenant(tenantId) {
    const alertConfigs = await AlertConfigRepo.findByTenant(tenantId);
    if (alertConfigs.length === 0) return;

    const minSla = Math.min(...alertConfigs.map(a => a.sla_minutes));
    let stuck = await EmailEventRepo.findStuck(tenantId, minSla);

    // FALHA_DEFINITIVA is not "stuck" (it's final) — but a lost lead must
    // alert immediately regardless of SLA (spec Req 15.6).
    try {
      const failures = await EmailEventRepo.findRecentFinalFailures(this.checkIntervalSec / 60 + 1);
      const tenantFailures = failures.filter(e => e.tenant_id === tenantId);
      stuck = stuck.concat(tenantFailures);
    } catch { /* non-fatal */ }

    if (stuck.length === 0) return;

    for (const alert of alertConfigs) {
      const relevant = stuck.filter(e => {
        if (e.status === 'FALHA_DEFINITIVA') return true; // always alert
        const ageMin = (Date.now() - new Date(e.created_at).getTime()) / 60_000;
        return ageMin >= alert.sla_minutes;
      });
      if (relevant.length === 0) continue;

      // Dedup: don't re-alert within sla_minutes (Req 15.7)
      const toAlert = relevant.filter(e => {
        const key = `${e.id}:${e.status}`;
        const lastAlert = this.lastAlertTimes.get(key);
        if (!lastAlert) return true;
        return (Date.now() - lastAlert) >= alert.sla_minutes * 60_000;
      });
      if (toAlert.length === 0) continue;

      // Send alert with retry (Req 15.8)
      let sent = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await this._sendAlert(alert, toAlert);
          sent = true;
          break;
        } catch (err) {
          logger.error(`[AlertService] delivery attempt ${attempt} failed: ${err.message}`);
          if (attempt < 3) await new Promise(r => setTimeout(r, 30_000));
        }
      }

      if (sent) {
        for (const e of toAlert) {
          this.lastAlertTimes.set(`${e.id}:${e.status}`, Date.now());
        }
      } else {
        logger.error(`[AlertService] failed to deliver alert ${alert.id} after 3 attempts`);
      }
    }
  }

  async _sendAlert(alert, events) {
    if (alert.alert_type === 'WEBHOOK') await this._sendWebhook(alert, events);
    else if (alert.alert_type === 'SLACK') await this._sendSlack(alert, events);
    else if (alert.alert_type === 'EMAIL') await this._sendEmail(alert, events);
  }

  async _sendWebhook(alert, events) {
    const res = await fetch(alert.destination, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        alert: 'emails_stuck',
        count: events.length,
        sla_min: alert.sla_minutes,
        events: events.map(e => ({
          id: e.id,
          from_email: e.from_email,
          subject: e.subject,
          status: e.status,
          age_min: Math.round((Date.now() - new Date(e.created_at)) / 60_000),
        })),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    // fetch only rejects on network errors — an HTTP 4xx/5xx is a failed
    // delivery and must go through the retry logic (spec Req 15.8).
    if (!res.ok) throw new Error(`webhook responded HTTP ${res.status}`);
  }

  async _sendSlack(alert, events) {
    const lines = events.map(e =>
      `• *${e.from_email}* — ${e.subject} (${e.status}, ${Math.round((Date.now() - new Date(e.created_at)) / 60_000)}min)`
    ).join('\n');

    const res = await fetch(alert.destination, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `:warning: *${events.length} email(s) stuck* for more than ${alert.sla_minutes}min:\n${lines}`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`slack webhook responded HTTP ${res.status}`);
  }

  async _sendEmail(alert, events) {
    const { createTransport } = await import('nodemailer');
    const transporter = createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      // Timeouts: a slow/hung SMTP server must not block the alert loop
      // (WEBHOOK/SLACK already use AbortSignal.timeout(10s)).
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });

    const lines = events.map(e =>
      `- ${e.from_email} | ${e.subject} | status: ${e.status}`
    ).join('\n');

    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: alert.destination,
      subject: `[Alert] ${events.length} email(s) stuck in pipeline`,
      text: `The following emails have been stuck for more than ${alert.sla_minutes} minutes:\n\n${lines}`,
    });
  }
}
