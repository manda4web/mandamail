import logger from '../logger.js';

/**
 * HeartbeatWorker — external dead-man's-switch.
 *
 * The in-process AlertService can warn about stuck emails and silent accounts,
 * but it CANNOT alert about its own outage: if the whole process (or the
 * server) dies, every internal worker dies with it and no alert is ever sent.
 *
 * This worker closes that gap by periodically pinging an EXTERNAL monitoring
 * URL (Healthchecks.io, cron.org, UptimeRobot push, BetterStack, etc.). As
 * long as the process is alive it keeps pinging; the moment it stops — crash,
 * OOM, server reboot, frozen event loop — the external monitor stops receiving
 * pings and raises the alarm on infrastructure OUTSIDE this process.
 *
 * Fully optional: with no HEARTBEAT_URL configured it does nothing, so it is
 * safe to leave wired up in every environment.
 */
export class HeartbeatWorker {
  /**
   * @param {object} [opts]
   * @param {string} [opts.url] - External heartbeat endpoint (defaults to env HEARTBEAT_URL)
   * @param {number} [opts.intervalMs] - Ping interval (defaults to env HEARTBEAT_INTERVAL_SEC or 60s)
   * @param {number} [opts.timeoutMs] - Per-ping timeout (default 10s)
   */
  constructor(opts = {}) {
    this.url = opts.url ?? process.env.HEARTBEAT_URL ?? null;
    const envInterval = parseInt(process.env.HEARTBEAT_INTERVAL_SEC ?? '60', 10);
    this.intervalMs = opts.intervalMs ?? (Number.isFinite(envInterval) ? envInterval * 1000 : 60_000);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.timer = null;
    this.consecutiveFailures = 0;
  }

  /**
   * @returns {boolean} true when a heartbeat URL is configured
   */
  isEnabled() {
    return typeof this.url === 'string' && this.url.length > 0;
  }

  start() {
    if (!this.isEnabled()) {
      logger.info('[Heartbeat] disabled (HEARTBEAT_URL not set) — external dead-man\'s-switch inactive');
      return;
    }
    // Ping once right away so the monitor sees us within the first interval,
    // then on a fixed cadence. .catch guarantees a rejected ping can never
    // escape as a process-wide unhandled rejection.
    this._ping().catch(() => {});
    this.timer = setInterval(() => this._ping().catch(() => {}), this.intervalMs);
    // Never let the heartbeat timer keep the event loop alive on shutdown.
    this.timer.unref?.();
    logger.info(`[Heartbeat] started — pinging external monitor every ${Math.round(this.intervalMs / 1000)}s`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Sends one heartbeat ping. Failures are logged but never thrown — a flaky
   * monitor endpoint must not affect the app. Repeated failures are surfaced
   * at WARN so an operator notices the monitoring itself is degraded.
   */
  async _ping() {
    if (!this.isEnabled()) return;
    try {
      const res = await fetch(this.url, {
        method: 'GET',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`monitor responded HTTP ${res.status}`);
      }
      if (this.consecutiveFailures > 0) {
        logger.info(`[Heartbeat] recovered after ${this.consecutiveFailures} failed ping(s)`);
      }
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures++;
      // Log level escalates: the first miss is INFO-noise, sustained misses
      // mean the monitoring path itself is broken and deserve a WARN.
      const msg = `[Heartbeat] ping failed (${this.consecutiveFailures}x): ${err.message}`;
      if (this.consecutiveFailures >= 3) logger.warn(msg);
      else logger.info(msg);
      throw err; // surfaced to the caller's .catch (kept from escaping there)
    }
  }
}
