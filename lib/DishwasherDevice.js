"use strict";

const BaseDevice = require("./BaseDevice");

// Dishwasher Device Implementation
class DishwasherDevice extends BaseDevice {
    constructor(adapter, config) {
        super(adapter, config);

        // Dishwasher specific parameters
        this.EPS = config.powerThreshold || 0.5;
        this.DETECT_TIME_MS = (config.detectTimeSeconds || 10) * 1000;
        this.REQUIRED_MINUTES = config.requiredMinutes || (config.requiredHours ? config.requiredHours * 60 : 120); // Fallback 2h
        this.MIN_RUNTIME_BEFORE_END = (config.minRuntimeMinutes || 110) * 60 * 1000;
        this.ZERO_GRACE_MS = (config.zeroGraceMinutes || 10) * 60 * 1000;
        this.POST_CONFIRM_MS = (config.postConfirmMinutes || 2) * 60 * 1000;
        this.COOLDOWN_AFTER_MS = (config.cooldownMinutes || 10) * 60 * 1000;
        this.DRY_REMINDER_MS = (config.dryReminderMinutes || 45) * 60 * 1000;

        // Internal state
        this.detectionTimer = null;
        this.startTimer = null;
        this.endTimer = null;
        this.postTimer = null;
        this.dryTimer = null;
        this.lastAboveZeroTs = 0;
        this.lastFinishTs = 0;
        this.automaticStartInProgress = false; // Prevent manual detection during auto start

        // Aktiviert generische Scheduling-Infrastruktur aus BaseDevice
        this.genericScheduling = true;
    }

    async createDeviceObjects(deviceId) {
        const dishwasherStates = [
            { id: "startDetected", common: { name: "Manual start detected", type: "boolean", role: "indicator", read: true, write: false, def: false } },
            { id: "runtime",       common: { name: "Runtime in milliseconds", type: "number", role: "value", unit: "ms", read: true, write: false, def: 0 } },
            { id: "avgPrice",      common: { name: "Average price for scheduled run (ct/kWh)", type: "number", role: "value", unit: "ct/kWh", read: true, write: false, def: 0 } }
        ];
        for (const state of dishwasherStates) {
            await this.adapter.setObjectNotExistsAsync(`${deviceId}.${state.id}`, { type: "state", common: state.common, native: {} });
        }
    }

    // ===================== Preis- und Scheduling-Helfer =====================

    _buildPriceIntervals(prices) {
        // Wandelt Tibber Einträge in Intervalle mit Start/Ende um (Ende = nächster startsAt)
        const intervals = [];
        for (let i = 0; i < prices.length - 1; i++) {
            const start = new Date(prices[i].startsAt);
            const next = new Date(prices[i + 1].startsAt);
            if (next > start) {
                intervals.push({ start, end: next, price: Number(prices[i].total) });
            }
        }
        return intervals;
    }

    _findCheapestWindowByMinutes(prices, requiredMinutes, notBefore = new Date()) {
        const intervals = this._buildPriceIntervals(prices).filter(iv => iv.end > notBefore);
        if (intervals.length === 0) return null;

        // Gesamtes verfügb. Ende
        const globalEnd = intervals[intervals.length - 1].end;
        const requiredMs = requiredMinutes * 60 * 1000;

        // Kandidaten: alle Intervall-Starts >= notBefore und notBefore selbst (gerundet auf Minute)
        const candidates = new Set();
        const nb = new Date(notBefore.getTime()); nb.setSeconds(0, 0);
        candidates.add(nb.getTime());
        for (const iv of intervals) {
            if (iv.start >= nb) candidates.add(iv.start.getTime());
        }

        let best = null;

        for (const ts of candidates) {
            const start = new Date(Number(ts));
            const endWanted = new Date(start.getTime() + requiredMs);
            if (endWanted > globalEnd) continue; // nicht vollständig abgedeckt

            let remaining = requiredMs;
            let cost = 0;
            for (const iv of intervals) {
                if (iv.end <= start) continue; // vor Fenster
                if (iv.start >= endWanted) break; // hinter Fenster
                const overlapStart = iv.start > start ? iv.start : start;
                const overlapEnd = iv.end < endWanted ? iv.end : endWanted;
                if (overlapEnd <= overlapStart) continue;
                const overlapMs = overlapEnd - overlapStart;
                cost += iv.price * (overlapMs / 60000); // Preis * Minuten
                remaining -= overlapMs;
                if (remaining <= 0) break;
            }
            if (remaining > 0) continue; // nicht vollständig abgedeckt
            const avgPricePerMin = cost / requiredMinutes; // €/kWh Durchschnitt
            if (!best || avgPricePerMin < best.avgPrice) {
                best = { startTime: start, endTime: endWanted, avgPrice: avgPricePerMin };
            }
        }
        return best;
    }

    // ===================== State Handling & Power Detection =================

    async onStateChange(id, state) {
        this.adapter.log.debug(`${this.name}: State change detected - ID: ${id}, Value: ${state?.val}, ACK: ${state?.ack}`);
        if (id === this.config.powerStateId) {
            await this.handlePowerChange(parseFloat(state.val) || 0);
        } else {
            // generisches Scheduling (Base) übernimmt restliche own states
            await super.onStateChange(id, state);
        }
    }

    async handlePowerChange(power) {
        const now = Date.now();
        const isRunning = await this.getStateValue("running");
        const isScheduled = await this.getStateValue("scheduled");
        this.adapter.log.debug(`${this.name}: Power changed to ${power}W`);

        if (power > this.EPS) {
            this.lastAboveZeroTs = now;
            this.clearEndTimers();
        }

        if (isRunning) {
            await this.handleEndDetection(power, now);
        } else {
            await this.handleStartDetection(power, now, isScheduled);
        }
    }

    async handleStartDetection(power, now, isScheduled) {
        if (now - this.lastFinishTs < this.COOLDOWN_AFTER_MS) return;
        if (power > this.EPS) {
            // Keine manuelle Start-Erkennung wenn automatischer Start noch in Progress
            if (!this.detectionTimer && !isScheduled && !this.automaticStartInProgress) {
                this.detectionTimer = this.adapter.setApplianceTimer(
                    `${this.id}_detection`,
                    async () => {
                        this.detectionTimer = null;
                        const currentPower = await this.getCurrentPower();
                        const currentRunning = await this.getStateValue("running");
                        const currentScheduled = await this.getStateValue("scheduled");
                        if (currentPower > this.EPS && !currentRunning && !currentScheduled && !this.automaticStartInProgress) {
                            await this.handleManualStart();
                        }
                    },
                    this.DETECT_TIME_MS
                );
            } else if (!this.startTimer) {
                this.startTimer = this.adapter.setApplianceTimer(
                    `${this.id}_start`,
                    async () => {
                        this.startTimer = null;
                        const currentPower = await this.getCurrentPower();
                        const currentRunning = await this.getStateValue("running");
                        if (currentPower > this.EPS && !currentRunning) {
                            await this.startDevice();
                        }
                    },
                    this.DETECT_TIME_MS
                );
            }
        } else { // power <= EPS
            if (this.detectionTimer) { this.adapter.clearApplianceTimer(`${this.id}_detection`); this.detectionTimer = null; }
            if (this.startTimer) { this.adapter.clearApplianceTimer(`${this.id}_start`); this.startTimer = null; }
        }
    }

    async handleEndDetection(power, now) {
        const startTime = await this.getStateValue("startTime");
        const runTime = now - (startTime ? new Date(startTime).getTime() : now);
        if (runTime < this.MIN_RUNTIME_BEFORE_END) {
            return; // zu früh für End-Erkennung
        }
        if (power <= this.EPS && !this.endTimer) {
            this.endTimer = this.adapter.setApplianceTimer(
                `${this.id}_end`,
                async () => {
                    this.endTimer = null;
                    const currentPower = await this.getCurrentPower();
                    const longNoActivity = (Date.now() - this.lastAboveZeroTs) >= this.ZERO_GRACE_MS;
                    if (currentPower <= this.EPS && longNoActivity) {
                        this.postTimer = this.adapter.setApplianceTimer(
                            `${this.id}_post`,
                            async () => {
                                this.postTimer = null;
                                const finalPower = await this.getCurrentPower();
                                if (finalPower <= this.EPS) {
                                    await this.finishDevice();
                                }
                            },
                            this.POST_CONFIRM_MS
                        );
                    }
                },
                this.ZERO_GRACE_MS
            );
        }
    }

    async handleManualStart() {
        this.adapter.log.info(`${this.name}: Manual start confirmed - switching off and planning optimal start`);
        if (this.config.switchStateId) {
            await this.adapter.setForeignStateAsync(this.config.switchStateId, false);
        }
        await this.sendNotification("Manual start detected - planning optimal restart time");
        await this.adapter.setStateAsync(`devices.${this.id}.startDetected`, true, true);
        setTimeout(async () => { await this.scheduleOptimalStart(); }, 2000);
    }

    async startDevice() {
        this.adapter.log.info(`${this.name}: Device started`);
        await this.adapter.setStateAsync(`devices.${this.id}.running`, true, true);
        await this.adapter.setStateAsync(`devices.${this.id}.startTime`, new Date().toISOString(), true);
        this.lastAboveZeroTs = Date.now();
        await this.clearDryReminder();
        this.automaticStartInProgress = false; // falls auto
        await this.sendNotification("Started");
    }

    async finishDevice() {
        if (this.lastFinishTs && (Date.now() - this.lastFinishTs) < this.COOLDOWN_AFTER_MS) return;
        this.adapter.log.info(`${this.name}: Device finished`);
        const startTime = await this.getStateValue("startTime");
        const runtime = Date.now() - (startTime ? new Date(startTime).getTime() : Date.now());
        await this.adapter.setStateAsync(`devices.${this.id}.running`, false, true);
        await this.adapter.setStateAsync(`devices.${this.id}.runtime`, runtime, true);
        this.lastFinishTs = Date.now();
        this.clearEndTimers();
        await this.sendNotification("Finished");
        try {
            await this.adapter.createTodoistTask({ content: `${this.name} ausräumen` });
        } catch (e) {
            this.adapter.log.warn(`${this.name}: Failed to create ToDoist task: ${e.message}`);
        }
        await this.scheduleDryReminder();
    }

    async scheduleDryReminder() {
        this.clearDryReminder();
        this.dryTimer = this.adapter.setApplianceTimer(
            `${this.id}_dry`,
            async () => { await this.sendNotification("Dishes should be dry now - please unload"); this.dryTimer = null; },
            this.DRY_REMINDER_MS
        );
    }

    clearDryReminder() { if (this.dryTimer) { this.adapter.clearApplianceTimer(`${this.id}_dry`); this.dryTimer = null; } }

    clearEndTimers() {
        if (this.endTimer) { this.adapter.clearApplianceTimer(`${this.id}_end`); this.endTimer = null; }
        if (this.postTimer) { this.adapter.clearApplianceTimer(`${this.id}_post`); this.postTimer = null; }
    }

    async getCurrentPower() {
        if (!this.config.powerStateId) return 0;
        const state = await this.adapter.getForeignStateAsync(this.config.powerStateId);
        return parseFloat(state?.val) || 0;
    }

    async getStateValue(stateName) {
        const state = await this.adapter.getStateAsync(`devices.${this.id}.${stateName}`);
        return state?.val;
    }

    async initializeStates() {
        // Konservative Initialisierung (bestehende Werte nicht überschreiben)
        const running = await this.getStateValue("running");
        const scheduled = await this.getStateValue("scheduled");
        const startTime = await this.getStateValue("startTime");
        const startDetected = await this.getStateValue("startDetected");
        const runtime = await this.getStateValue("runtime");
        const avgPrice = await this.getStateValue("avgPrice");
        if (running === null || running === undefined) await this.adapter.setStateAsync(`devices.${this.id}.running`, false, true);
        if (scheduled === null || scheduled === undefined) await this.adapter.setStateAsync(`devices.${this.id}.scheduled`, false, true);
        if (startTime === null || startTime === undefined) await this.adapter.setStateAsync(`devices.${this.id}.startTime`, "", true);
        if (startDetected === null || startDetected === undefined) await this.adapter.setStateAsync(`devices.${this.id}.startDetected`, false, true);
        if (runtime === null || runtime === undefined) await this.adapter.setStateAsync(`devices.${this.id}.runtime`, 0, true);
        if (avgPrice === null || avgPrice === undefined) await this.adapter.setStateAsync(`devices.${this.id}.avgPrice`, 0, true);
        // Generisches Scheduling wiederherstellen
        await this.restoreScheduledOperations();
    }

    // =============== Minutengenaue optimale Planung =========================
    async scheduleOptimalStart() {
        try {
            this.adapter.log.info(`${this.name}: Searching for optimal start window (${this.REQUIRED_MINUTES}min)`);
            const prices = await this.adapter.getTibberPrices();
            const optimal = this._findCheapestWindowByMinutes(prices, this.REQUIRED_MINUTES, new Date());
            if (!optimal) throw new Error("No suitable window found");

            const avgCt = (optimal.avgPrice * 100).toFixed(2);
            await this.adapter.setStateAsync(`devices.${this.id}.avgPrice`, parseFloat(avgCt), true);
            await this.scheduleStartAt(optimal.startTime);

            const fmtDate = d => `${d.getDate()}.${d.getMonth()+1}.${d.getFullYear()}`;
            const fmtTime = d => `${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}`;
            let msg = `Plan für \"${this.name}\" [${this.REQUIRED_MINUTES} min]:`;
            msg += `\n- ${fmtDate(optimal.startTime)}, ${fmtTime(optimal.startTime)} → ${fmtTime(optimal.endTime)}`;
            await this.sendNotification(msg);
        } catch (error) {
            this.adapter.log.error(`${this.name}: Optimization failed: ${error.message}`);
            await this.sendNotification(`Tibber optimization failed: ${error.message}`);
        }
    }

    // Überschreibt performScheduledStart aus BaseDevice
    async performScheduledStart() {
        // Set flag to suppress manual start detection
        this.automaticStartInProgress = true;

        if (this.config.switchStateId) {
            try { await this.adapter.setForeignStateAsync(this.config.switchStateId, true); }
            catch (e) { this.adapter.log.warn(`${this.name}: Failed to switch on: ${e.message}`); }
        }

        // Flag nach 5 Minuten wieder deaktivieren, falls Start nicht erkannt
        setTimeout(() => {
            if (this.automaticStartInProgress) {
                this.automaticStartInProgress = false;
                this.adapter.log.debug(`${this.name}: Automatic start flag timeout cleared`);
            }
        }, 5 * 60 * 1000);
    }

    stop() {
        super.stop();
        const timerKeys = [`${this.id}_detection`, `${this.id}_start`, `${this.id}_end`, `${this.id}_post`, `${this.id}_dry`];
        timerKeys.forEach(key => this.adapter.clearApplianceTimer(key));
        this.detectionTimer = null;
        this.startTimer = null;
        this.endTimer = null;
        this.postTimer = null;
        this.dryTimer = null;
    }
}

module.exports = DishwasherDevice;
