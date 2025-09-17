"use strict";

const BaseDevice = require("./BaseDevice");

// Washing Machine Device Implementation
class WashingMachineDevice extends BaseDevice {
    constructor(adapter, config) {
        super(adapter, config);

        // Washing machine parameters
        this.EPS = config.powerThreshold || 0.5;
        this.DETECT_TIME_MS = (config.detectTimeSeconds || 10) * 1000;
        this.MIN_RUNTIME_BEFORE_END = (config.minRuntimeMinutes || 60) * 60 * 1000; // default 60min
        this.ZERO_GRACE_MS = (config.zeroGraceMinutes || 5) * 60 * 1000; // default 5min
        this.POST_CONFIRM_MS = (config.postConfirmMinutes || 1) * 60 * 1000; // default 1min
        this.COOLDOWN_AFTER_MS = (config.cooldownMinutes || 10) * 60 * 1000;

        // Internal state
        this.detectionTimer = null;
        this.startTimer = null;
        this.endTimer = null;
        this.postTimer = null;
        this.lastAboveZeroTs = 0;
        this.lastFinishTs = 0;
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
        const now = Date.now();
        const isRunning = await this.getStateValue("running");
        this.adapter.log.debug(`${this.name}: Power changed to ${power}W`);

        if (power > this.EPS) {
            this.lastAboveZeroTs = now;
            this.clearEndTimers();
            this.adapter.log.debug(`${this.name}: Activity detected - timers cleared`);
        }

        if (isRunning) {
            await this.handleEndDetection(power, now);
        } else {
            await this.handleStartDetection(power, now);
        }
    }

    async handleStartDetection(power, now) {
        // Cooldown guard
        if (now - this.lastFinishTs < this.COOLDOWN_AFTER_MS) return;

        if (power > this.EPS) {
            if (!this.startTimer) {
                this.startTimer = this.adapter.setApplianceTimer(
                    `${this.id}_start`,
                    async () => {
                        this.startTimer = null;
                        const currentPower = await this.getCurrentPower();
                        const running = await this.getStateValue("running");
                        if (currentPower > this.EPS && !running) {
                            await this.startDevice();
                        }
                    },
                    this.DETECT_TIME_MS
                );
            }
        } else if (this.startTimer) {
            this.adapter.clearApplianceTimer(`${this.id}_start`);
            this.startTimer = null;
        }
    }

    async handleEndDetection(power, now) {
        const startTime = await this.getStateValue("startTime");
        const runTime = now - (startTime ? new Date(startTime).getTime() : now);

        if (runTime < this.MIN_RUNTIME_BEFORE_END) {
            const runTimeMinutes = Math.round(runTime / 60000);
            this.adapter.log.debug(`${this.name}: End detection - Power: ${power}W, Runtime: ${runTimeMinutes}min, MinRuntime: ${Math.round(this.MIN_RUNTIME_BEFORE_END / 60000)}min`);
            return;
        }

        if (power <= this.EPS && !this.endTimer) {
            this.adapter.log.debug(`${this.name}: Zero power detected, starting end detection`);

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

    async startDevice() {
        this.adapter.log.info(`${this.name}: Device started`);
        await this.adapter.setStateAsync(`devices.${this.id}.running`, true, true);
        await this.adapter.setStateAsync(`devices.${this.id}.startTime`, new Date().toISOString(), true);
        this.lastAboveZeroTs = Date.now();
        await this.adapter.sendNotification(`${this.name}: Started`);
    }

    async finishDevice() {
        // prevent duplicate finishes
        if (this.lastFinishTs && (Date.now() - this.lastFinishTs) < this.COOLDOWN_AFTER_MS) {
            this.adapter.log.debug(`${this.name}: Device finish called too soon after last finish - ignoring`);
            return;
        }

        this.adapter.log.info(`${this.name}: Device finished`);

        const startTime = await this.getStateValue("startTime");
        const runtime = Date.now() - (startTime ? new Date(startTime).getTime() : Date.now());

        await this.adapter.setStateAsync(`devices.${this.id}.running`, false, true);
        await this.adapter.setStateAsync(`devices.${this.id}.runtime`, runtime, true);

        this.lastFinishTs = Date.now();
        this.clearEndTimers();

        await this.adapter.sendNotification(`${this.name}: Finished`);

        // ToDoist task
        try {
            await this.adapter.createTodoistTask({
                content: `${this.name} aufhängen`,
                projectId: this.adapter.config.todoistProjectId,
                sectionId: this.adapter.config.todoistSectionId,
                priority: this.adapter.config.todoistPriority
            });
        } catch (e) {
            this.adapter.log.warn(`${this.name}: Failed to create ToDoist task: ${e.message}`);
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

    clearEndTimers() {
        if (this.endTimer) {
            this.adapter.clearApplianceTimer(`${this.id}_end`);
            this.endTimer = null;
        }
        if (this.postTimer) {
            this.adapter.clearApplianceTimer(`${this.id}_post`);
            this.postTimer = null;
        }
        if (this.startTimer) {
            this.adapter.clearApplianceTimer(`${this.id}_start`);
            this.startTimer = null;
        }
    }

    stop() {
        super.stop();
        ["start", "end", "post"].forEach(suffix => this.adapter.clearApplianceTimer(`${this.id}_${suffix}`));
        this.detectionTimer = null;
        this.startTimer = null;
        this.endTimer = null;
        this.postTimer = null;
    }
}

module.exports = WashingMachineDevice;
