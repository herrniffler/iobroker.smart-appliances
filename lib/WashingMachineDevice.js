"use strict";

const BaseDevice = require("./BaseDevice");

// Washing Machine Device Implementation
class WashingMachineDevice extends BaseDevice {
    constructor(adapter, config) {
        super(adapter, config);
        this.EPS = config.powerThreshold || 0.5;
        this.POST_CONFIRM_MS = (config.postConfirmMinutes || 1) * 60 * 1000;
        this.postTimer = null;
        this.startTriggerDelayMs = Number(config.startTriggerDelayMs || 5000);
        this.startTriggerStateId = config.startTriggerStateId; // z.B. SwitchBot press
        this.transferBufferMinutes = Number(config.transferBufferMinutes || 10); // Puffer zwischen Waschende und Trockner
        // Aktiviert generische Scheduling-Funktionalität im BaseDevice
        this.genericScheduling = true;
    }

    // === Helpers =============================================================
    minutesToMs(m) { return m * 60 * 1000; }

    /**
     * Stunde-Ende (Date) zu einem Stundenstart (Date oder ISO)
     */
    _hourEnd(d) {
        const start = (d instanceof Date) ? d : new Date(d);
        return new Date(start.getTime() + 60 * 60 * 1000);
    }

    /**
     * Zeit-gewichteter Durchschnittspreis (€/kWh) für [start, start+minutes)
     * Preise: Array mit { startsAt (ISO), total (€/kWh) } stündlich.
     */
    _weightedAvg(prices, start, minutes) {
        const end = new Date(start.getTime() + this.minutesToMs(minutes));
        let totalCost = 0;
        let remaining = minutes;

        for (let i = 0; i < prices.length; i++) {
            const hStart = new Date(prices[i].startsAt);
            const hEnd = this._hourEnd(hStart);
            const price = Number(prices[i].total);

            // Überschneidung berechnen
            const overlapStart = (start > hStart) ? start : hStart;
            const overlapEnd = (end < hEnd) ? end : hEnd;

            if (overlapEnd > overlapStart) {
                const overlapMins = (overlapEnd - overlapStart) / 60000;
                totalCost += price * overlapMins;
                remaining -= overlapMins;
                if (remaining <= 0) break;
            }
        }

        const used = minutes - Math.max(0, remaining);
        if (used <= 0) return null; // keine Abdeckung
        return totalCost / used;
    }

    /**
     * Günstigste minute-genaue Zeitspanne mit fester Dauer (minutes).
     */
    _findCheapestWindowByMinutes(prices, minutes, notBefore = new Date()) {
        if (!Array.isArray(prices) || prices.length === 0) return null;
        const lastHourStart = new Date(prices[prices.length - 1].startsAt);
        const lastEnd = this._hourEnd(lastHourStart);

        const candidates = new Set();

        // Start an Stundengrenzen
        for (let i = 0; i < prices.length; i++) {
            const s = new Date(prices[i].startsAt);
            if (s >= notBefore && new Date(s.getTime() + this.minutesToMs(minutes)) <= lastEnd) {
                candidates.add(s.getTime());
            }
        }
        // Ende an Stundengrenzen
        for (let i = 0; i < prices.length; i++) {
            const e = this._hourEnd(new Date(prices[i].startsAt));
            const s = new Date(e.getTime() - this.minutesToMs(minutes));
            if (s >= notBefore && e <= lastEnd) {
                candidates.add(s.getTime());
            }
        }
        // notBefore selbst testen
        const sNB = new Date(notBefore);
        if (new Date(sNB.getTime() + this.minutesToMs(minutes)) <= lastEnd) {
            candidates.add(sNB.getTime());
        }

        let best = null;
        for (const ts of candidates) {
            const start = new Date(Number(ts));
            const avg = this._weightedAvg(prices, start, minutes);
            if (avg == null) continue;
            if (!best || avg < best.avgPrice) {
                best = {
                    startTime: start,
                    endTime: new Date(start.getTime() + this.minutesToMs(minutes)),
                    avgPrice: avg
                };
            }
        }
        return best;
    }

    // === Object creation / states ===========================================
    async createDeviceObjects(deviceId) {
        const washingMachineStates = [
            {
                id: "runtime",
                common: {
                    name: "Runtime in milliseconds",
                    type: "number",
                    role: "value",
                    unit: "ms",
                    read: true,
                    write: false,
                    def: 0
                }
            },
            {
                id: "task_id",
                common: {
                    name: "ToDoist Main Task ID",
                    type: "string",
                    role: "value",
                    read: true,
                    write: true,
                    def: ""
                }
            },
            {
                id: "subtask_gewaschen_id",
                common: {
                    name: "ToDoist Subtask Gewaschen ID",
                    type: "string",
                    role: "value",
                    read: true,
                    write: true,
                    def: ""
                }
            },
            {
                id: "transferBufferMinutes",
                common: {
                    name: "Transfer buffer minutes (Washer -> Dryer)",
                    type: "number",
                    role: "value",
                    unit: "min",
                    read: true,
                    write: true,
                    def: this.transferBufferMinutes || 10
                }
            }
        ];

        for (const state of washingMachineStates) {
            await this.adapter.setObjectNotExistsAsync(`${deviceId}.${state.id}`, {
                type: "state",
                common: state.common,
                native: {}
            });
        }
    }

    // === Power monitoring ====================================================
    async onStateChange(id, state) {
        this.adapter.log.debug(`${this.name}: State change detected - ID: ${id}, Value: ${state?.val}, ACK: ${state?.ack}`);

        if (id === this.config.powerStateId) {
            this.adapter.log.debug(`${this.name}: Power state matched - calling handlePowerChange`);
            await this.handlePowerChange(parseFloat(state.val) || 0);
            return;
        }
        // Delegation an BaseDevice für generic scheduling
        await super.onStateChange(id, state);
    }

    async handlePowerChange(power) {
        const isRunning = await this.getStateValue("running");
        if (power > this.EPS && !isRunning) {
            await this.startDevice();
        } else if (power <= this.EPS && isRunning) {
            // Starte Nachlauf-Timer
            if (!this.postTimer) {
                this.adapter.log.debug(`${this.name}: Power < EPS, starting POST_CONFIRM_MS timer (${this.POST_CONFIRM_MS}ms)`);
                this.postTimer = setTimeout(async () => {
                    this.postTimer = null;
                    const currentPower = await this.getCurrentPower();
                    const stillRunning = await this.getStateValue("running");
                    if (currentPower <= this.EPS && stillRunning) {
                        await this.finishDevice();
                    }
                }, this.POST_CONFIRM_MS);
            }
        } else if (power > this.EPS && this.postTimer) {
            // Wenn wieder > EPS, Timer abbrechen
            clearTimeout(this.postTimer);
            this.postTimer = null;
        }
    }

    async startDevice() {
        this.adapter.log.info(`${this.name}: Device started`);
        await this.adapter.setStateAsync(`devices.${this.id}.running`, true, true);
        // Echte Startzeit überschreiben
        await this.adapter.setStateAsync(`devices.${this.id}.startTime`, new Date().toISOString(), true);
        // Sicherstellen dass scheduled zurückgesetzt ist
        const scheduled = await this.getStateValue("scheduled");
        if (scheduled) {
            await this.adapter.setStateAsync(`devices.${this.id}.scheduled`, false, true);
        }
        await this.adapter.sendNotification(`${this.name}: Started`);
        await this.createTodoistMainTaskWithSubtasks();
    }

    async createTodoistMainTaskWithSubtasks() {
        try {
            const now = new Date();
            const pad = n => n.toString().padStart(2, '0');
            const dateStr = `${pad(now.getDate())}.${pad(now.getMonth()+1)}.${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
            const mainTask = await this.adapter.createTodoistTask({
                content: `Wäsche - ${dateStr}`,
            });
            if (!mainTask || !mainTask.id) {
                this.adapter.log.warn(`${this.name}: Could not create main ToDoist task.`);
                return;
            }
            await this.adapter.setStateAsync(`devices.${this.id}.task_id`, mainTask.id, true);
            const subtasks = ["Gewaschen", "Getrocknet", "Entfusselt", "Zusammengelegt", "Aufgeräumt"];
            for (let i = 0; i < subtasks.length; i++) {
                const subtask = await this.adapter.createTodoistTask({
                    content: subtasks[i],
                    parentId: mainTask.id,
                    order: i + 1
                });
                if (subtasks[i] === "Gewaschen" && subtask && subtask.id) {
                    await this.adapter.setStateAsync(`devices.${this.id}.subtask_gewaschen_id`, subtask.id, true);
                }
            }
        } catch (e) {
            this.adapter.log.warn(`${this.name}: Error creating ToDoist main/subtasks: ${e.message}`);
        }
    }

    async finishDevice() {
        this.adapter.log.info(`${this.name}: Device finished`);
        const startTime = await this.getStateValue("startTime");
        const runtime = Date.now() - (startTime ? new Date(startTime).getTime() : Date.now());
        await this.adapter.setStateAsync(`devices.${this.id}.running`, false, true);
        await this.adapter.setStateAsync(`devices.${this.id}.runtime`, runtime, true);
        await this.adapter.sendNotification(`${this.name}: Finished`);
        await this.closeTodoistSubtaskGewaschen();
    }

    async closeTodoistSubtaskGewaschen() {
        try {
            const subtaskId = await this.getStateValue("subtask_gewaschen_id");
            if (!subtaskId) {
                this.adapter.log.warn(`${this.name}: No subtask_gewaschen_id found to close.`);
                return;
            }
            await this.adapter.closeTodoistTask(subtaskId);
            this.adapter.log.info(`${this.name}: Closed ToDoist subtask 'Gewaschen' (${subtaskId})`);
        } catch (e) {
            this.adapter.log.warn(`${this.name}: Error closing ToDoist subtask 'Gewaschen': ${e.message}`);
        }
    }

    async getCurrentPower() {
        if (!this.config.powerStateId) return 0;
        const state = await this.adapter.getForeignStateAsync(this.config.powerStateId);
        return parseFloat(state?.val) || 0;
    }

    async getStateValue(stateName) {
        const state = await this.adapter.getStateAsync(`devices.${this.id}.${stateName}`);
        return (state && state.val !== undefined) ? state.val : null;
    }

    async initializeStates() {
        // Initialize basic states only if they don't exist
        const running = await this.getStateValue("running");
        const startTime = await this.getStateValue("startTime");
        const runtime = await this.getStateValue("runtime");
        const taskId = await this.getStateValue("task_id");
        const subtaskGewaschenId = await this.getStateValue("subtask_gewaschen_id");
        const scheduled = await this.getStateValue("scheduled");
        const transferBuffer = await this.getStateValue("transferBufferMinutes");

        if (running === null) {
            await this.adapter.setStateAsync(`devices.${this.id}.running`, false, true);
        }
        if (startTime === null) {
            await this.adapter.setStateAsync(`devices.${this.id}.startTime`, "", true);
        }
        if (runtime === null) {
            await this.adapter.setStateAsync(`devices.${this.id}.runtime`, 0, true);
        }
        if (taskId === null) {
            await this.adapter.setStateAsync(`devices.${this.id}.task_id`, "", true);
        }
        if (subtaskGewaschenId === null) {
            await this.adapter.setStateAsync(`devices.${this.id}.subtask_gewaschen_id`, "", true);
        }
        if (scheduled === null) {
            await this.adapter.setStateAsync(`devices.${this.id}.scheduled`, false, true);
        }
        if (transferBuffer === null) {
            await this.adapter.setStateAsync(`devices.${this.id}.transferBufferMinutes`, this.transferBufferMinutes, true);
        }
    }

    stop() {
        super.stop();
        if (this.postTimer) { clearTimeout(this.postTimer); this.postTimer = null; }
    }

    // Überschreibt generic performScheduledStart aus BaseDevice
    async performScheduledStart() {
        // Sicherheitsprüfungen analog zur alten Logik
        const runningState = await this.adapter.getStateAsync(`devices.${this.id}.running`);
        if (runningState?.val) {
            this.adapter.log.warn(`${this.name}: performScheduledStart aborted – already running`);
            return;
        }
        const currentPower = await this.getCurrentPower();
        if (currentPower > this.EPS) {
            this.adapter.log.warn(`${this.name}: performScheduledStart aborted – power > EPS (${currentPower}W)`);
            return;
        }
        // Steckdose einschalten
        if (this.config.switchStateId) {
            try { await this.adapter.setForeignStateAsync(this.config.switchStateId, true); }
            catch (e) { this.adapter.log.warn(`${this.name}: Failed to switch plug on: ${e.message}`); }
        }
        // Optionaler Start-Trigger (SwitchBot) nach Delay
        if (this.startTriggerStateId) {
            setTimeout(async () => {
                try {
                    this.adapter.log.info(`${this.name}: Triggering start via ${this.startTriggerStateId}`);
                    await this.adapter.setForeignStateAsync(this.startTriggerStateId, true); // kein Zurücksetzen erforderlich
                } catch (e) {
                    this.adapter.log.warn(`${this.name}: Failed to trigger start: ${e.message}`);
                }
            }, this.startTriggerDelayMs);
        }
    }

    // Planung ruft nun generic scheduleStartAt()
    async planWashingProgram({ program, duration, dryerNeeded, dryerDuration }) {
        // 1) Preise holen
        const prices = await this.adapter.getTibberPrices();
        if (!Array.isArray(prices) || prices.length === 0) {
            this.adapter.log.warn(`${this.name}: No Tibber prices available`);
            return;
        }
        const now = new Date();
        const washMinutes  = Math.max(1, Number(duration) || 0);
        const deviceDryerDuration = Number(this.config.dryerDuration) || 0;
        const dryMinutes   = dryerNeeded ? (Number(dryerDuration) || deviceDryerDuration || 0) : 0;
        let result = null;
        // 2) Varianten berechnen (minutengenau)
        const findWin = (mins, earliest) => this._findCheapestWindowByMinutes(prices, mins, earliest);

        // read current transfer buffer (state override possible)
        const cfgBuffer = Number(this.config.transferBufferMinutes) || this.transferBufferMinutes || 0;
        const stateBuffer = Number(await this.getStateValue("transferBufferMinutes")) || 0;
        const bufferMinutes = (stateBuffer > 0) ? stateBuffer : cfgBuffer;

        if (dryerNeeded) {
            // Kombinierter Gesamtzeitraum
            const combined = findWin(washMinutes + dryMinutes, now);

            // Split: zuerst Waschen, danach Trockner ab Wasch-Ende + Buffer
            const washWin = findWin(washMinutes, now);
            let split = null;
            if (washWin) {
                const earliestDryStart = new Date(washWin.endTime.getTime() + bufferMinutes * 60000);
                const dryerWin = findWin(dryMinutes, earliestDryStart);
                if (dryerWin && dryerWin.startTime >= earliestDryStart) {
                    const splitAvg = (washWin.avgPrice * washMinutes + dryerWin.avgPrice * dryMinutes) / (washMinutes + dryMinutes);
                    split = { variant: "split", withDryer: true, startTime: washWin.startTime, endTime: dryerWin.endTime,
                        wash: { start: washWin.startTime, end: washWin.endTime, avgPrice: washWin.avgPrice },
                        dryer: { start: dryerWin.startTime, end: dryerWin.endTime, avgPrice: dryerWin.avgPrice },
                        avgPriceWash: washWin.avgPrice, avgPriceDryer: dryerWin.avgPrice, _combinedAvg: splitAvg, transferBufferMinutes: bufferMinutes };
                }
            }
            const combinedResult = combined ? { variant: "combined", withDryer: true, startTime: combined.startTime, endTime: combined.endTime,
                avgPriceWash: combined.avgPrice, avgPriceDryer: combined.avgPrice, _combinedAvg: combined.avgPrice } : null;
            if (combinedResult && split) result = (combinedResult._combinedAvg <= split._combinedAvg) ? combinedResult : split; else result = combinedResult || split || null;
        } else {
            // Nur Waschen
            const win = findWin(washMinutes, now);
            if (!win) { this.adapter.log.warn(`${this.name}: No suitable window for washing found`); await this.adapter.sendNotification(`No suitable time slot found for '${program}'`); return; }
            result = { variant: "washOnly", withDryer: false, startTime: win.startTime, endTime: win.endTime, avgPriceWash: win.avgPrice, avgPriceDryer: 0 };
        }
        if (!result) { this.adapter.log.warn(`${this.name}: No suitable time slot found for planning`); await this.adapter.sendNotification(`No suitable time slot found for '${program}'`); return; }

        // Generisches Scheduling nutzen
        await this.scheduleStartAt(result.startTime);

        const fmtDate = d => `${d.getDate()}.${d.getMonth()+1}.${d.getFullYear()}`;
        const fmtTime = d => `${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}`;
        let msg = `Plan für Waschprogramm '${program}' [`;
        msg += `${washMinutes} min`;
        if (result.withDryer) msg += ` + ${dryMinutes} min`;
        msg += `]:\n`;
        if (result.variant === "split" && result.wash && result.dryer) {
            msg += `\n- Waschen ${fmtDate(result.wash.start)}, ${fmtTime(result.wash.start)} → ${fmtTime(result.wash.end)}`;
            msg += `\n- Trockner ${fmtDate(result.dryer.start)}, ${fmtTime(result.dryer.start)} → ${fmtTime(result.dryer.end)}`;
            if (result.transferBufferMinutes && result.transferBufferMinutes > 0) {
                msg += `\n- Transfer Buffer: ${result.transferBufferMinutes} min (Zeit zum Umladen)`;
            }
        } else if (result.variant === "combined") {
            const washEnd = new Date(result.startTime.getTime() + washMinutes * 60000);
            msg += `\n- Waschen ${fmtDate(result.startTime)}, ${fmtTime(result.startTime)} → ${fmtTime(washEnd)}`;
            msg += `\n- Trockner ${fmtDate(washEnd)}, ${fmtTime(washEnd)} → ${fmtTime(result.endTime)}`;
        } else {
            msg += `\n- Waschen ${fmtDate(result.startTime)}, ${fmtTime(result.startTime)} → ${fmtTime(result.endTime)}`;
        }
        await this.adapter.sendNotification(msg);
        this.adapter.log.info(`${this.name}: ${msg}`);
    }
}

module.exports = WashingMachineDevice;
