"use strict";

const BaseDevice = require("./BaseDevice");

// Dishwasher Device Implementation
class DishwasherDevice extends BaseDevice {
    constructor(adapter, config) {
        super(adapter, config);

        // Dishwasher specific parameters
        this.EPS = config.powerThreshold || 0.5;
        this.DETECT_TIME_MS = (config.detectTimeSeconds || 10) * 1000;
        this.REQUIRED_HOURS = config.requiredHours || 2;
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
        this.scheduledStartTimer = null;
        this.automaticStartInProgress = false; // Flag to prevent manual start detection during automatic start
    }

    async createDeviceObjects(deviceId) {
        const dishwasherStates = [
            {
                id: "startDetected",
                common: {
                    name: "Manual start detected",
                    type: "boolean",
                    role: "indicator",
                    read: true,
                    write: false,
                    def: false
                }
            },
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
                id: "avgPrice",
                common: {
                    name: "Average price for scheduled run",
                    type: "number",
                    role: "value",
                    unit: "ct/kWh",
                    read: true,
                    write: false,
                    def: 0
                }
            }
        ];

        for (const state of dishwasherStates) {
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
        } else if (id.endsWith(".startTime") && state.val && !state.ack) {
            this.adapter.log.debug(`${this.name}: Start time change detected`);
            await this.handleManualStartTimeChange(state.val);
        } else if (id.endsWith(".scheduled") && state.val === false && !state.ack) {
            this.adapter.log.debug(`${this.name}: Scheduled cancelled`);
            await this.cancelScheduledStart();
        } else {
            this.adapter.log.debug(`${this.name}: State change ignored - not matching any handler`);
            this.adapter.log.debug(`${this.name}: Expected powerStateId: ${this.config.powerStateId}`);
        }
    }

    async handlePowerChange(power) {
        const now = Date.now();
        const isRunning = await this.getStateValue("running");
        const isScheduled = await this.getStateValue("scheduled");
        this.adapter.log.debug(`${this.name}: Power changed to ${power}W`);

        // Update last activity timestamp
        if (power > this.EPS) {
            this.lastAboveZeroTs = now;
            this.clearEndTimers();
            this.adapter.log.debug(`${this.name}: Activity detected - timers cleared`);
        }

        if (isRunning) {
            await this.handleEndDetection(power, now);
        } else {
            await this.handleStartDetection(power, now, isScheduled);
        }
    }

    async handleStartDetection(power, now, isScheduled) {
        // Check cooldown period
        if (now - this.lastFinishTs < this.COOLDOWN_AFTER_MS) {
            return;
        }

        if (power > this.EPS) {
            // Don't detect manual start if automatic start is in progress
            if (!this.detectionTimer && !isScheduled && !this.automaticStartInProgress) {
                // Manual start detection
                this.adapter.log.debug(`${this.name}: Possible manual start detected`);

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
                // Normal start detection (for both manual and automatic starts)
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
        } else {
            // Power dropped - cancel detection
            if (this.detectionTimer) {
                this.adapter.clearApplianceTimer(`${this.id}_detection`);
                this.detectionTimer = null;
            }
            if (this.startTimer) {
                this.adapter.clearApplianceTimer(`${this.id}_start`);
                this.startTimer = null;
            }
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

    async handleManualStart() {
        this.adapter.log.info(`${this.name}: Manual start confirmed - switching off and planning optimal start`);

        // Switch off immediately
        if (this.config.switchStateId) {
            await this.adapter.setForeignStateAsync(this.config.switchStateId, false);
        }

        await this.sendNotification("Manual start detected - planning optimal restart time");
        await this.adapter.setStateAsync(`devices.${this.id}.startDetected`, true, true);

        // Plan optimal start
        setTimeout(async () => {
            await this.scheduleOptimalStart();
        }, 2000);
    }

    async startDevice() {
        this.adapter.log.info(`${this.name}: Device started`);

        await this.adapter.setStateAsync(`devices.${this.id}.running`, true, true);
        await this.adapter.setStateAsync(`devices.${this.id}.startTime`, new Date(), true);

        this.lastAboveZeroTs = Date.now();
        this.clearDryReminder();
        await this.cancelScheduledStart();

        // Clear automatic start flag when device actually starts
        this.automaticStartInProgress = false;

        await this.sendNotification("Started");
    }

    async finishDevice() {
        this.adapter.log.info(`${this.name}: Device finished`);

        const startTime = await this.getStateValue("startTime");
        const runtime = Date.now() - (startTime ? new Date(startTime).getTime() : Date.now());

        await this.adapter.setStateAsync(`devices.${this.id}.running`, false, true);
        await this.adapter.setStateAsync(`devices.${this.id}.runtime`, runtime, true);

        this.lastFinishTs = Date.now();

        await this.sendNotification("Finished");
        await this.scheduleDryReminder();
    }

    async scheduleOptimalStart() {
        try {
            this.adapter.log.info(`${this.name}: Searching for optimal start time`);

            const prices = await this.adapter.getTibberPrices();
            const optimalBlock = this.adapter.findCheapestConsecutiveHours(prices, this.REQUIRED_HOURS);

            const startTimeStr = optimalBlock.startTime.toLocaleString("de-DE");
            const avgPrice = (optimalBlock.avgPrice * 100).toFixed(2);

            // Save scheduled start
            await this.adapter.setStateAsync(`devices.${this.id}.startTime`, optimalBlock.startTime, true);
            await this.adapter.setStateAsync(`devices.${this.id}.scheduled`, true, true);
            await this.adapter.setStateAsync(`devices.${this.id}.avgPrice`, parseFloat(avgPrice), true);

            const message = `Optimal start planned:\nStart: ${startTimeStr}\nAvg. price: ${avgPrice} ct/kWh`;
            await this.sendNotification(message);

            // Set timer for automatic start
            const delay = optimalBlock.startTime.getTime() - Date.now();
            if (delay > 0) {
                this.scheduledStartTimer = this.adapter.setApplianceTimer(
                    `${this.id}_scheduled`,
                    async () => {
                        await this.executeScheduledStart();
                    },
                    delay
                );

                this.adapter.log.info(`${this.name}: Timer set for ${Math.round(delay / 60000)} minutes`);
                this.adapter.log.debug(`${this.name}: Start time: ${startTimeStr}`);
            } else {
                await this.executeScheduledStart();
            }

        } catch (error) {
            this.adapter.log.error(`${this.name}: Tibber optimization failed: ${error.message}`);
            await this.sendNotification(`Tibber optimization failed: ${error.message}`);
        }
    }

    async executeScheduledStart() {
        const isScheduled = await this.getStateValue("scheduled");

        if (!isScheduled) {
            this.adapter.log.debug(`${this.name}: Scheduled start cancelled`);
            return;
        }

        this.adapter.log.info(`${this.name}: Executing scheduled start`);

        // Set flag to prevent manual start detection
        this.automaticStartInProgress = true;

        // Switch on
        if (this.config.switchStateId) {
            await this.adapter.setForeignStateAsync(this.config.switchStateId, true);
        }

        // Reset scheduling
        await this.adapter.setStateAsync(`devices.${this.id}.scheduled`, false, true);
        await this.adapter.setStateAsync(`devices.${this.id}.startTime`, "", true);

        await this.sendNotification("Automatically started (Tibber optimized)");

        // Clear flag after a reasonable time (30 seconds) to allow normal detection again
        setTimeout(() => {
            this.automaticStartInProgress = false;
            this.adapter.log.debug(`${this.name}: Automatic start flag cleared`);
        }, 30000);
    }

    async handleManualStartTimeChange(newStartTime) {
        const isScheduled = await this.getStateValue("scheduled");

        if (!newStartTime || !isScheduled) {
            return;
        }

        try {
            const startTime = new Date(newStartTime);
            const delay = startTime.getTime() - Date.now();

            if (delay <= 0) {
                await this.executeScheduledStart();
            } else {
                this.adapter.log.info(`${this.name}: Start time manually changed to ${startTime.toLocaleString("de-DE")}`);
                await this.sendNotification(`Start time changed to ${startTime.toLocaleString("de-DE")}`);

                // Clear old timer and set new one
                if (this.scheduledStartTimer) {
                    this.adapter.clearApplianceTimer(`${this.id}_scheduled`);
                }

                this.scheduledStartTimer = this.adapter.setApplianceTimer(
                    `${this.id}_scheduled`,
                    async () => {
                        await this.executeScheduledStart();
                    },
                    delay
                );
            }
        } catch (error) {
            this.adapter.log.error(`${this.name}: Invalid start time: ${error.message}`);
            await this.sendNotification("Invalid start time set");
        }
    }

    async cancelScheduledStart() {
        const wasScheduled = await this.getStateValue("scheduled");

        if (wasScheduled) {
            await this.adapter.setStateAsync(`devices.${this.id}.scheduled`, false, true);
            await this.adapter.setStateAsync(`devices.${this.id}.startTime`, "", true);

            if (this.scheduledStartTimer) {
                this.adapter.clearApplianceTimer(`${this.id}_scheduled`);
                this.scheduledStartTimer = null;
            }

            this.adapter.log.info(`${this.name}: Scheduled start cancelled`);
            await this.sendNotification("Scheduled start cancelled");
        }
    }

    async scheduleDryReminder() {
        this.clearDryReminder();

        this.dryTimer = this.adapter.setApplianceTimer(
            `${this.id}_dry`,
            async () => {
                await this.sendNotification("Dishes should be dry now - please unload");
                this.dryTimer = null;
            },
            this.DRY_REMINDER_MS
        );
    }

    clearDryReminder() {
        if (this.dryTimer) {
            this.adapter.clearApplianceTimer(`${this.id}_dry`);
            this.dryTimer = null;
        }
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
        const scheduled = await this.getStateValue("scheduled");
        const startTime = await this.getStateValue("startTime");

        if (running === null) {
            await this.adapter.setStateAsync(`devices.${this.id}.running`, false, true);
        }
        if (scheduled === null) {
            await this.adapter.setStateAsync(`devices.${this.id}.scheduled`, false, true);
        }
        if (startTime === null) {
            await this.adapter.setStateAsync(`devices.${this.id}.startTime`, "", true);
        }

        // Restore scheduled operations after restart
        await this.restoreScheduledOperations();
    }

    async restoreScheduledOperations() {
        const isScheduled = await this.getStateValue("scheduled");
        const startTimeStr = await this.getStateValue("startTime");

        if (isScheduled && startTimeStr) {
            try {
                const startTime = new Date(startTimeStr);
                const now = new Date();
                const delay = startTime.getTime() - now.getTime();

                this.adapter.log.info(`${this.name}: Restoring scheduled start after restart`);
                this.adapter.log.info(`${this.name}: Planned start time: ${startTime.toLocaleString("de-DE")}`);

                if (delay <= 0) {
                    // Start time is in the past - execute immediately
                    this.adapter.log.warn(`${this.name}: Scheduled start time was in the past - executing now`);
                    await this.executeScheduledStart();
                } else if (delay > 24 * 60 * 60 * 1000) {
                    // Start time is more than 24 hours in the future - probably invalid
                    this.adapter.log.warn(`${this.name}: Scheduled start time is more than 24h in future - cancelling`);
                    await this.cancelScheduledStart();
                } else {
                    // Valid future start time - restore timer
                    this.scheduledStartTimer = this.adapter.setApplianceTimer(
                        `${this.id}_scheduled`,
                        async () => {
                            await this.executeScheduledStart();
                        },
                        delay
                    );

                    this.adapter.log.info(`${this.name}: Timer restored - ${Math.round(delay / 60000)} minutes remaining`);
                    await this.sendNotification(`Scheduled start restored: ${Math.round(delay / 60000)} minutes remaining`);
                }
            } catch (error) {
                this.adapter.log.error(`${this.name}: Failed to restore scheduled start: ${error.message}`);
                await this.cancelScheduledStart();
            }
        }

        // Check if device was running before restart
        const wasRunning = await this.getStateValue("running");
        if (wasRunning) {
            this.adapter.log.info(`${this.name}: Device was running before restart - resuming monitoring`);
            this.lastAboveZeroTs = Date.now(); // Reset activity timestamp
            await this.sendNotification("Monitoring resumed after adapter restart");
        }
    }

    stop() {
        super.stop();

        // Clear all timers
        const timerKeys = [`${this.id}_detection`, `${this.id}_start`, `${this.id}_end`, `${this.id}_post`, `${this.id}_scheduled`, `${this.id}_dry`];
        timerKeys.forEach(key => this.adapter.clearApplianceTimer(key));

        this.detectionTimer = null;
        this.startTimer = null;
        this.endTimer = null;
        this.postTimer = null;
        this.scheduledStartTimer = null;
        this.dryTimer = null;
    }
}

module.exports = DishwasherDevice;
