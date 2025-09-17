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
            // Starte Nachlauf-Timer wie im alten Script
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
        // Haupttask anlegen
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
            // Subtasks anlegen
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
        // Subtask "Gewaschen" schließen
        await this.closeTodoistSubtaskGewaschen();
    }

    async closeTodoistSubtaskGewaschen() {
        try {
            const subtaskId = await this.getStateValue("subtask_gewaschen_id");
            if (!subtaskId) {
                this.adapter.log.warn(`${this.name}: No subtask_gewaschen_id found to close.`);
                return;
            }
            await this.adapter.sendToAsync(
                this.adapter.config.todoistInstance || "todoist2.0",
                "send",
                { funktion: "close_task", id: subtaskId }
            );
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

    stop() {
        super.stop();
        if (this.postTimer) {
            clearTimeout(this.postTimer);
            this.postTimer = null;
        }
    }
}

module.exports = WashingMachineDevice;
