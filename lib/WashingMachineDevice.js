"use strict";

const BaseDevice = require("./BaseDevice");

// Washing Machine Device Implementation
class WashingMachineDevice extends BaseDevice {
    constructor(adapter, config) {
        super(adapter, config);
        this.EPS = config.powerThreshold || 0.5;
        this.POST_CONFIRM_MS = (config.postConfirmMinutes || 1) * 60 * 1000;
        this.postTimer = null;
    }

    // === Helpers =============================================================
    minutesToMs(m) { return m * 60 * 1000; }

    _isConsecutiveHour(prevISO, currISO) {
        const prev = new Date(prevISO);
        const curr = new Date(currISO);
        return (curr - prev) / (1000 * 60 * 60) === 1;
    }

    /**
     * Kombinierter Block: sucht günstigsten lückenlosen Block über N Stunden (ab jetzt in der Zukunft).
     * Rückgabe: { startIndex, startTime: Date, avgPrice }
     */
    _findCheapestCombinedBlock(prices, hours) {
        const now = new Date();
        // erste künftige Stunde suchen
        let startIdx = prices.findIndex(p => new Date(p.startsAt) > now);
        if (startIdx < 0) startIdx = prices.length; // nichts in der Zukunft

        let best = null;
        let lowestAvg = Infinity;

        for (let i = startIdx; i <= prices.length - hours; i++) {
            let total = prices[i].total;
            let ok = true;
            for (let j = 1; j < hours; j++) {
                if (!this._isConsecutiveHour(prices[i + j - 1].startsAt, prices[i + j].startsAt)) {
                    ok = false; break;
                }
                total += prices[i + j].total;
            }
            if (!ok) continue;

            const avg = total / hours;
            if (avg < lowestAvg) {
                lowestAvg = avg;
                best = {
                    startIndex: i,
                    startTime: new Date(prices[i].startsAt),
                    avgPrice: avg
                };
            }
        }
        return best;
    }

    /**
     * Günstigsten lückenlosen Block (hours) suchen, der NICHT VOR notBefore startet.
     * Rückgabe: { startIndex, startTime: Date, avgPrice }
     */
    _findCheapestBlockFrom(prices, hours, notBefore) {
        const notBeforeTs = notBefore?.getTime?.() || new Date(notBefore).getTime();
        // Startindex: erste Stunde mit startsAt >= notBefore
        let startIdx = prices.findIndex(p => new Date(p.startsAt).getTime() >= notBeforeTs);
        if (startIdx < 0) return null;

        let best = null;
        let lowestAvg = Infinity;

        for (let i = startIdx; i <= prices.length - hours; i++) {
            let total = prices[i].total;
            let ok = true;
            for (let j = 1; j < hours; j++) {
                const prev = prices[i + j - 1].startsAt;
                const curr = prices[i + j].startsAt;
                if (!this._isConsecutiveHour(prev, curr)) { ok = false; break; }
                total += prices[i + j].total;
            }
            if (!ok) continue;
            const avg = total / hours;
            if (avg < lowestAvg) {
                lowestAvg = avg;
                best = {
                    startIndex: i,
                    startTime: new Date(prices[i].startsAt),
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
        } else {
            this.adapter.log.debug(`${this.name}: State change ignored - not matching any handler`);
            this.adapter.log.debug(`${this.name}: Expected powerStateId: ${this.config.powerStateId}`);
        }
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
        await this.adapter.setStateAsync(`devices.${this.id}.startTime`, new Date().toISOString(), true);
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
        return state?.val;
    }

    async initializeStates() {
        // Initialize basic states only if they don't exist
        const running = await this.getStateValue("running");
        const startTime = await this.getStateValue("startTime");
        const runtime = await this.getStateValue("runtime");
        const taskId = await this.getStateValue("task_id");
        const subtaskGewaschenId = await this.getStateValue("subtask_gewaschen_id");

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

        // Restore scheduled operations after restart
        await this.restoreScheduledOperations();
    }

    async restoreScheduledOperations() {
        const wasRunning = await this.getStateValue("running");
        if (wasRunning) {
            this.adapter.log.info(`${this.name}: Device was running before restart - resuming monitoring`);
        }
    }

    stop() {
        super.stop();
        if (this.postTimer) {
            clearTimeout(this.postTimer);
            this.postTimer = null;
        }
    }

    // === Planning ============================================================
    async planWashingProgram({ program, duration, dryerNeeded, dryerDuration }) {
        // 1) Daten vorbereiten
        const prices = await this.adapter.getTibberPrices();
        if (!Array.isArray(prices) || prices.length === 0) {
            this.adapter.log.warn(`${this.name}: No Tibber prices available`);
            return;
        }

        const washMinutes  = Math.max(1, Number(duration) || 0);
        const dryMinutes   = dryerNeeded ? Math.max(1, Number(dryerDuration) || 0) : 0;
        const washHours    = Math.ceil(washMinutes / 60);
        const dryerHours   = dryerNeeded ? Math.ceil(dryMinutes / 60) : 0;

        // 2) Varianten berechnen
        let result = null;

        if (dryerNeeded) {
            // Variante 1: kombinierter Block (Waschen+Trockner am Stück)
            const totalHours = washHours + dryerHours;
            const combined = this._findCheapestCombinedBlock(prices, totalHours);

            // Variante 2: getrennte Blöcke (Trockner MUSS nach Waschende starten!)
            let washBlock = null;
            try {
                washBlock = this.adapter.findCheapestConsecutiveHours(prices, washHours);
            } catch (e) {
                this.adapter.log.debug(`${this.name}: wash block not available: ${e.message}`);
            }

            let dryerBlock = null;
            if (washBlock) {
                const washStart = washBlock.startTime;
                const washEnd   = new Date(washStart.getTime() + this.minutesToMs(washMinutes));
                dryerBlock      = this._findCheapestBlockFrom(prices, dryerHours, washEnd);
            }

            // 3) Endzeiten IMMER auf Minutenbasis berechnen
            const buildCombinedResult = (block) => {
                if (!block) return null;
                const start = block.startTime;
                const end   = new Date(start.getTime() + this.minutesToMs(washMinutes + dryMinutes));
                return {
                    variant: "combined",
                    withDryer: true,
                    startTime: start,
                    endTime: end,
                    avgPriceWash: block.avgPrice,
                    avgPriceDryer: block.avgPrice
                };
            };

            const buildSplitResult = (wash, dry) => {
                if (!wash || !dry) return null;
                const washStart = wash.startTime;
                const washEnd   = new Date(washStart.getTime() + this.minutesToMs(washMinutes));
                const dryStart  = dry.startTime;
                const dryEnd    = new Date(dryStart.getTime() + this.minutesToMs(dryMinutes));

                // Sicherheitscheck: Dryer muss NACH Waschende starten
                if (dryStart < washEnd) {
                    // Sollte durch _findCheapestBlockFrom schon ausgeschlossen sein,
                    // aber wir sichern hier zusätzlich ab.
                    return null;
                }

                return {
                    variant: "split",
                    withDryer: true,
                    startTime: washStart,
                    endTime:   dryEnd,
                    wash:  { start: washStart, end: washEnd, avgPrice: wash.avgPrice },
                    dryer: { start: dryStart,  end: dryEnd,  avgPrice: dry.avgPrice },
                    avgPriceWash: wash.avgPrice,
                    avgPriceDryer: dry.avgPrice
                };
            };

            const combinedResult = buildCombinedResult(combined);
            const splitResult    = buildSplitResult(washBlock, dryerBlock);

            // 4) Entscheidung – wenn beide vorhanden, den günstigeren Durchschnitt heranziehen
            if (combinedResult && splitResult) {
                const combinedAvg = combinedResult.avgPriceWash; // identisch
                const splitAvg    = (
                    (splitResult.avgPriceWash * washMinutes) +
                    (splitResult.avgPriceDryer * dryMinutes)
                ) / (washMinutes + dryMinutes);

                result = (combinedAvg <= splitAvg) ? combinedResult : splitResult;
            } else {
                result = combinedResult || splitResult || null;
            }

        } else {
            // Nur Waschen
            let washBlock = null;
            try {
                washBlock = this.adapter.findCheapestConsecutiveHours(prices, washHours);
            } catch (e) {
                this.adapter.log.warn(`${this.name}: No suitable block for washing found: ${e.message}`);
                return;
            }
            const start = washBlock.startTime;
            const end   = new Date(start.getTime() + this.minutesToMs(washMinutes));

            result = {
                variant: "washOnly",
                withDryer: false,
                startTime: start,
                endTime: end,
                avgPriceWash: washBlock.avgPrice,
                avgPriceDryer: 0
            };
        }

        if (!result) {
            this.adapter.log.warn(`${this.name}: No suitable time slot found for planning`);
            await this.adapter.sendNotification(`No suitable time slot found for '${program}'`);
            return;
        }

        // 5) States schreiben
        await this.adapter.setStateAsync(`devices.${this.id}.planned.start`, result.startTime.toISOString(), true);
        await this.adapter.setStateAsync(`devices.${this.id}.planned.end`,   result.endTime.toISOString(), true);
        await this.adapter.setStateAsync(`devices.${this.id}.planned.withDryer`, !!result.withDryer, true);
        await this.adapter.setStateAsync(`devices.${this.id}.planned.variant`, result.variant, true);
        await this.adapter.setStateAsync(`devices.${this.id}.planned.avgPriceWash`, Number(result.avgPriceWash || 0), true);
        await this.adapter.setStateAsync(`devices.${this.id}.planned.avgPriceDryer`, Number(result.avgPriceDryer || 0), true);

        // 6) Benachrichtigung (klar & ehrlich)
        const fmt = (d) => d.toLocaleString(); // ggf. de-DE verwenden
        let msg = `Plan for washing program '${program}' (${Math.round(washMinutes)} min`;
        if (result.withDryer) msg += ` + dryer ${Math.round(dryMinutes)} min`;
        msg += `): `;

        if (result.variant === "split" && result.wash && result.dryer) {
            msg += `Wash ${fmt(result.wash.start)}→${fmt(result.wash.end)} (avg ${result.avgPriceWash.toFixed(3)} €/kWh), `;
            msg += `Dryer ${fmt(result.dryer.start)}→${fmt(result.dryer.end)} (avg ${result.avgPriceDryer.toFixed(3)} €/kWh). `;
            msg += `Overall span ${fmt(result.startTime)}→${fmt(result.endTime)}.`;
        } else {
            msg += `Start ${fmt(result.startTime)}, End ${fmt(result.endTime)}, `;
            msg += `Avg price ${result.avgPriceWash.toFixed(3)} €/kWh.`;
        }

        this.adapter.log.info(`${this.name}: ${msg}`);
        await this.adapter.sendNotification(msg);
    }
}

module.exports = WashingMachineDevice;
