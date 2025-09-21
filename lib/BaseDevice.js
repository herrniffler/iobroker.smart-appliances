"use strict";

// Base Device Class
class BaseDevice {
    constructor(adapter, config) {
        this.adapter = adapter;
        this.config = config;
        this.id = config.id;
        this.name = config.name;
        this.type = config.type;

        // State management
        this.states = new Map();
        this.subscriptions = [];

        // Generic scheduling support flag (must be enabled by derived class or config)
        this.genericScheduling = !!config.genericScheduling; // derived class can override to true
        this._scheduledTimer = null; // internal timer reference for generic scheduling
    }

    async init() {
        this.adapter.log.info(`Initializing device: ${this.name}`);

        // Create device object structure
        await this.createObjects();

        // Subscribe to relevant states
        await this.subscribe();

        // Initialize device states
        await this.initializeStates();
    }

    async createObjects() {
        const deviceId = `devices.${this.id}`;

        // Create device channel
        await this.adapter.setObjectNotExistsAsync(deviceId, {
            type: "channel",
            common: {
                name: this.name,
                role: "device"
            },
            native: this.config
        });

        // Create common states
        const commonStates = [
            {
                id: "running",
                common: {
                    name: "Device running",
                    type: "boolean",
                    role: "indicator",
                    read: true,
                    write: false,
                    def: false
                }
            },
            {
                id: "scheduled",
                common: {
                    name: "Scheduled start active",
                    type: "boolean",
                    role: "indicator",
                    read: true,
                    write: true,
                    def: false
                }
            },
            {
                id: "startTime",
                common: {
                    name: "Planned start time",
                    type: "string",
                    role: "value.datetime",
                    read: true,
                    write: true,
                    def: ""
                }
            }
        ];

        for (const state of commonStates) {
            await this.adapter.setObjectNotExistsAsync(`${deviceId}.${state.id}`, {
                type: "state",
                common: state.common,
                native: {}
            });
        }

        // Create device-specific objects
        await this.createDeviceObjects(deviceId);
    }

    async createDeviceObjects(deviceId) {
        // Override in derived classes
    }

    async subscribe() {
        // Subscribe to power measurement
        if (this.config.powerStateId) {
            await this.adapter.subscribeForeignStatesAsync(this.config.powerStateId);
            this.subscriptions.push(this.config.powerStateId);
        }

        // Subscribe to switch control
        if (this.config.switchStateId) {
            await this.adapter.subscribeForeignStatesAsync(this.config.switchStateId);
            this.subscriptions.push(this.config.switchStateId);
        }

        // Subscribe to own states
        await this.adapter.subscribeStatesAsync(`devices.${this.id}.*`);
    }

    async initializeStates() {
        // Initialize basic states
        await this.adapter.setStateAsync(`devices.${this.id}.running`, false, true);
        await this.adapter.setStateAsync(`devices.${this.id}.scheduled`, false, true);
        await this.adapter.setStateAsync(`devices.${this.id}.startTime`, "", true);

        // Check for existing scheduled starts after adapter restart
        await this.restoreScheduledOperations();
    }

    async restoreScheduledOperations() {
        if (!this.genericScheduling) return; // only if enabled
        try {
            const scheduledState = await this.adapter.getStateAsync(`devices.${this.id}.scheduled`);
            const startTimeState = await this.adapter.getStateAsync(`devices.${this.id}.startTime`);
            const isScheduled = scheduledState?.val === true;
            const startTimeStr = startTimeState?.val;
            if (isScheduled && startTimeStr) {
                const startTime = new Date(startTimeStr);
                const delay = startTime.getTime() - Date.now();
                if (isNaN(startTime.getTime())) {
                    this.adapter.log.warn(`${this.name}: Invalid stored startTime -> cancelling schedule`);
                    await this.cancelScheduledStart();
                } else if (delay <= 0) {
                    this.adapter.log.info(`${this.name}: Stored start time already passed -> executing now`);
                    await this._executeScheduledStart();
                } else if (delay > 48 * 60 * 60 * 1000) { // >48h plausibility check
                    this.adapter.log.warn(`${this.name}: Stored start time more than 48h away -> cancelling`);
                    await this.cancelScheduledStart();
                } else {
                    this.adapter.log.info(`${this.name}: Restoring scheduled start in ${Math.round(delay/60000)} minutes (${startTime.toLocaleString()})`);
                    this._setScheduledTimer(delay);
                }
            }
        } catch (e) {
            this.adapter.log.warn(`${this.name}: Failed to restore scheduling: ${e.message}`);
        }
    }

    handlesState(stateId) {
        return this.subscriptions.includes(stateId) ||
               stateId.startsWith(`${this.adapter.namespace}.devices.${this.id}.`);
    }

    async onStateChange(id, state) {
        // Base generic scheduling reactions (only if enabled)
        if (this.genericScheduling && state) {
            const isStartTime = id.endsWith(`devices.${this.id}.startTime`);
            const isScheduled = id.endsWith(`devices.${this.id}.scheduled`);

            // Manuelle Eingaben (ack=false) zuerst behandeln
            if (!state.ack) {
                if (isStartTime) {
                    await this._handleManualStartTimeInput(state.val);
                } else if (isScheduled) {
                    await this._handleManualScheduledInput(state.val);
                }
            } else {
                // Adapter-bestätigte Änderungen
                if (isScheduled && state.val === false) {
                    // cancellation
                    await this.cancelScheduledStart(false); // already false
                } else if (isStartTime) {
                    // startTime change -> if scheduled true recalc
                    const scheduled = await this.adapter.getStateAsync(`devices.${this.id}.scheduled`);
                    if (scheduled?.val === true) {
                        await this._recalculateScheduledTimer();
                    }
                }
            }
        }
        this.adapter.log.debug(`Device ${this.name}: State ${id} changed to ${state?.val}`);
    }

    async _handleManualStartTimeInput(value) {
        if (value === null || value === undefined || value === "") return; // ignore empty
        const date = new Date(value);
        if (isNaN(date.getTime())) {
            this.adapter.log.warn(`${this.name}: Invalid manual startTime '${value}' ignored`);
            return;
        }
        // Ack setzen, falls noch nicht
        await this.adapter.setStateAsync(`devices.${this.id}.startTime`, date.toISOString(), true);
        const scheduledState = await this.adapter.getStateAsync(`devices.${this.id}.scheduled`);
        if (scheduledState?.val === true) {
            // Neu planen mit diesem Zeitpunkt
            const delay = date.getTime() - Date.now();
            if (delay <= 0) {
                await this._executeScheduledStart();
            } else {
                this.adapter.log.info(`${this.name}: Manual startTime updated -> rescheduling (${Math.round(delay/60000)} min)`);
                this._setScheduledTimer(delay);
            }
        } else {
            this.adapter.log.info(`${this.name}: Manual startTime stored (not scheduled yet)`);
        }
    }

    async _handleManualScheduledInput(val) {
        if (val === true) {
            const startTimeState = await this.adapter.getStateAsync(`devices.${this.id}.startTime`);
            const startStr = startTimeState?.val;
            if (!startStr) {
                this.adapter.log.warn(`${this.name}: Cannot enable scheduling – startTime empty`);
                await this.adapter.setStateAsync(`devices.${this.id}.scheduled`, false, true);
                return;
            }
            const date = new Date(startStr);
            if (isNaN(date.getTime())) {
                this.adapter.log.warn(`${this.name}: Cannot enable scheduling – startTime invalid`);
                await this.adapter.setStateAsync(`devices.${this.id}.scheduled`, false, true);
                return;
            }
            await this.adapter.setStateAsync(`devices.${this.id}.scheduled`, true, true); // ack
            const delay = date.getTime() - Date.now();
            if (delay <= 0) {
                await this._executeScheduledStart();
            } else {
                this.adapter.log.info(`${this.name}: Scheduling enabled manually (${Math.round(delay/60000)} min)`);
                this._setScheduledTimer(delay);
            }
        } else if (val === false) {
            // Manuelles Abschalten
            await this.cancelScheduledStart();
        }
    }

    async startMonitoring() {
        // Start device-specific monitoring - override in derived classes
        this.adapter.log.info(`Started monitoring device: ${this.name}`);
    }

    stop() {
        // Cleanup - override in derived classes
        this.adapter.log.info(`Stopped device: ${this.name}`);
        this._clearScheduledTimer();
    }

    async sendNotification(message) {
        const prefixedMessage = `${this.name}: ${message}`;
        await this.adapter.sendNotification(prefixedMessage);
    }

    // =========== Generic Scheduling API ====================================

    async scheduleStartAt(startTime) {
        if (!this.genericScheduling) {
            this.adapter.log.warn(`${this.name}: scheduleStartAt called but genericScheduling not enabled`);
            return;
        }
        let start;
        if (startTime instanceof Date) start = startTime; else start = new Date(startTime);
        if (isNaN(start.getTime())) {
            this.adapter.log.warn(`${this.name}: scheduleStartAt received invalid date`);
            return;
        }
        await this.adapter.setStateAsync(`devices.${this.id}.startTime`, start.toISOString(), true);
        await this.adapter.setStateAsync(`devices.${this.id}.scheduled`, true, true);
        const delay = start.getTime() - Date.now();
        if (delay <= 0) {
            this.adapter.log.info(`${this.name}: Planned start time already past -> executing immediately`);
            await this._executeScheduledStart();
        } else {
            this.adapter.log.info(`${this.name}: Scheduled start in ${Math.round(delay/60000)} minutes (${start.toLocaleString()})`);
            this._setScheduledTimer(delay);
        }
    }

    async cancelScheduledStart(sendNotification = true) {
        if (!this.genericScheduling) return;
        const sched = await this.adapter.getStateAsync(`devices.${this.id}.scheduled`);
        if (sched?.val !== true) return;
        this._clearScheduledTimer();
        await this.adapter.setStateAsync(`devices.${this.id}.scheduled`, false, true);
        if (sendNotification) await this.sendNotification("Scheduled start cancelled");
    }

    _setScheduledTimer(delay) {
        this._clearScheduledTimer();
        this._scheduledTimer = setTimeout(() => {
            this._scheduledTimer = null;
            this._executeScheduledStart();
        }, delay);
    }

    _clearScheduledTimer() {
        if (this._scheduledTimer) {
            clearTimeout(this._scheduledTimer);
            this._scheduledTimer = null;
        }
    }

    async _recalculateScheduledTimer() {
        const startTimeState = await this.adapter.getStateAsync(`devices.${this.id}.startTime`);
        const startStr = startTimeState?.val;
        if (!startStr) return;
        const start = new Date(startStr);
        if (isNaN(start.getTime())) {
            this.adapter.log.warn(`${this.name}: Invalid startTime on recalculation -> cancelling`);
            await this.cancelScheduledStart();
            return;
        }
        const delay = start.getTime() - Date.now();
        if (delay <= 0) {
            await this._executeScheduledStart();
        } else {
            this.adapter.log.info(`${this.name}: Recalculated schedule -> ${Math.round(delay/60000)} minutes`);
            this._setScheduledTimer(delay);
        }
    }

    async _executeScheduledStart() {
        const scheduledState = await this.adapter.getStateAsync(`devices.${this.id}.scheduled`);
        if (!scheduledState || scheduledState.val !== true) {
            this.adapter.log.debug(`${this.name}: _executeScheduledStart aborted (flag false)`);
            return;
        }
        try {
            await this.sendNotification("Executing scheduled start");
            await this.performScheduledStart();
        } catch (e) {
            this.adapter.log.warn(`${this.name}: performScheduledStart failed: ${e.message}`);
        } finally {
            // Default behavior: scheduled flag false, keep startTime for historical reference until real run detected
            await this.adapter.setStateAsync(`devices.${this.id}.scheduled`, false, true);
        }
    }

    async performScheduledStart() {
        // Default implementation: switch on if switchStateId exists
        if (this.config.switchStateId) {
            try {
                await this.adapter.setForeignStateAsync(this.config.switchStateId, true);
            } catch (e) {
                this.adapter.log.warn(`${this.name}: Failed to switch on: ${e.message}`);
            }
        } else {
            this.adapter.log.debug(`${this.name}: performScheduledStart no switchStateId configured`);
        }
    }
}

module.exports = BaseDevice;
