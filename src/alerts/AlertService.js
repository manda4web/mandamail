import { db } from '../db/client.js';
import { EmailEventRepo } from '../db/repos/EmailEventRepo.js';
import { AlertConfigRepo } from '../db/repos/AlertConfigRepo.js';
import logger from '../logger.js';

export class AlertService {
  constructor(checkIntervalSec = 60) {
    this.checkIntervalSec = checkIntervalSec;
    this.intervalId = null;
    this.lastAlertTimes = new Map(); // eventId:status -> timestamp
  }

  start() {
    this.intervalId = setInterval(() => this.checkAll(), this.checkIntervalSec * 1000);
    this.checkAll(); // run immediately
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
  }

  async _checkTenant(tenantId) {
    const alertConfigs = await AlertConfigRepo.findByTenant(tenantId);
    if (alertConfigs.length === 0) return;

    const minSla = Math.min(...alertConfigs.map(a => a.sla_minutes));
    const stuck = await EmailEventRepo.findStuck(tenantId, minSla);
    if (stuck.length === 0) return;

    for (const alert of alertConfigs) {
      const relevant = stuck.filter(e => {
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
    await fetch(alert.destination, {
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
  }

  async _sendSlack(alert, events) {
    const lines = events.map(e =>
      `• *${e.from_email}* — ${e.subject} (${e.status}, ${Math.round((Date.now() - new Date(e.created_at)) / 60_000)}min)`
    ).join('\n');

    await fetch(alert.destination, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `:warning: *${events.length} email(s) stuck* for more than ${alert.sla_minutes}min:\n${lines}`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  }

  async _sendEmail(alert, events) {
    const { createTransport } = await import('nodemailer');
    const transporter = createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
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
