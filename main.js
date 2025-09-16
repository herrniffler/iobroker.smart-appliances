"use strict";

const utils = require("@iobroker/adapter-core");

class SmartAppliances extends utils.Adapter {

    constructor(options = {}) {
        super({
            ...options,
            name: "smart-appliances",
        });

        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("objectChange", this.onObjectChange.bind(this));
        this.on("unload", this.onUnload.bind(this));

        // Geräteverwaltung
        this.devices = new Map();
        this.timers = new Map();
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize the adapter
        this.log.info("Smart Appliances Adapter starting...");

        // Reset the connection indicator during startup
        this.setState("info.connection", false, true);

        // Load devices from configuration
        await this.loadDevices();

        // Start device monitoring
        await this.startDeviceMonitoring();

        // Set connection status
        this.setState("info.connection", true, true);
        this.log.info("Smart Appliances Adapter started successfully");
    }

    /**
     * Load devices from adapter configuration
     */
    async loadDevices() {
        const devices = this.config.devices || [];

        for (const deviceConfig of devices) {
            if (!deviceConfig.enabled) continue;

            this.log.info(`Loading device: ${deviceConfig.name} (${deviceConfig.type})`);

            // Create device instance based on type
            let device;
            switch (deviceConfig.type) {
                case "dishwasher":
                    device = new DishwasherDevice(this, deviceConfig);
                    break;
                case "washingmachine":
                    device = new WashingMachineDevice(this, deviceConfig);
                    break;
                case "dryer":
                    device = new DryerDevice(this, deviceConfig);
                    break;
                default:
                    this.log.warn(`Unknown device type: ${deviceConfig.type}`);
                    continue;
            }

            // Initialize device
            await device.init();
            this.devices.set(deviceConfig.id, device);
        }

        this.log.info(`Loaded ${this.devices.size} devices`);
    }

    /**
     * Start monitoring all devices
     */
    async startDeviceMonitoring() {
        for (const [deviceId, device] of this.devices) {
            await device.startMonitoring();
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     */
    onUnload(callback) {
        try {
            this.log.info("Shutting down Smart Appliances Adapter...");

            // Clear all timers
            for (const [key, timer] of this.timers) {
                clearTimeout(timer);
            }
            this.timers.clear();

            // Stop all devices
            for (const [deviceId, device] of this.devices) {
                device.stop();
            }

            this.setState("info.connection", false, true);
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     */
    onStateChange(id, state) {
        if (state) {
            this.log.debug(`State ${id} changed: ${state.val} (ack = ${state.ack})`);

            // Forward to appropriate device
            for (const [deviceId, device] of this.devices) {
                if (device.handlesState(id)) {
                    device.onStateChange(id, state);
                    break;
                }
            }
        } else {
            this.log.debug(`State ${id} deleted`);
        }
    }

    /**
     * Is called if a subscribed object changes
     */
    onObjectChange(id, obj) {
        if (obj) {
            this.log.debug(`Object ${id} changed: ${JSON.stringify(obj)}`);
        } else {
            this.log.debug(`Object ${id} deleted`);
        }
    }

    /**
     * Send notification via configured services
     */
    async sendNotification(message, priority = "normal") {
        this.log.info(`Notification: ${message}`);

        // Telegram notification
        if (this.config.notifications?.telegram?.enabled) {
            const instance = this.config.notifications.telegram.instance;
            try {
                await this.sendToAsync(instance, message);
            } catch (error) {
                this.log.warn(`Failed to send Telegram notification: ${error.message}`);
            }
        }
    }

    /**
     * Get Tibber prices
     */
    async getTibberPrices() {
        if (!this.config.tibberEnabled || !this.config.tibberHome) {
            throw new Error("Tibber not configured");
        }

        const tibberHome = this.config.tibberHome;
        const todayId = `tibberlink.0.Homes.${tibberHome}.PricesToday.json`;
        const tomorrowId = `tibberlink.0.Homes.${tibberHome}.PricesTomorrow.json`;

        const todayState = await this.getForeignStateAsync(todayId);
        const tomorrowState = await this.getForeignStateAsync(tomorrowId);

        if (!todayState || !todayState.val) {
            throw new Error("Tibber Today data not available");
        }

        let allPrices = [];

        try {
            const todayPrices = JSON.parse(todayState.val);
            allPrices = allPrices.concat(todayPrices);

            if (tomorrowState && tomorrowState.val) {
                const tomorrowPrices = JSON.parse(tomorrowState.val);
                allPrices = allPrices.concat(tomorrowPrices);
            }

            return allPrices;
        } catch (error) {
            throw new Error(`Failed to parse Tibber data: ${error.message}`);
        }
    }

    /**
     * Find cheapest consecutive hours
     */
    findCheapestConsecutiveHours(prices, requiredHours) {
        if (!prices || prices.length < requiredHours) {
            throw new Error("Not enough price data available");
        }

        let bestBlock = null;
        let lowestAvgPrice = Infinity;

        const currentTime = new Date();
        const futureStartIndex = prices.findIndex(entry => {
            const entryTime = new Date(entry.startsAt);
            return entryTime > currentTime;
        });

        if (futureStartIndex === -1 || futureStartIndex + requiredHours > prices.length) {
            throw new Error("No valid future time windows available");
        }

        for (let i = futureStartIndex; i <= prices.length - requiredHours; i++) {
            let totalPrice = 0;
            let validBlock = true;

            for (let j = 0; j < requiredHours; j++) {
                const currentEntry = prices[i + j];
                totalPrice += currentEntry.total;

                if (j > 0) {
                    const prevTime = new Date(prices[i + j - 1].startsAt);
                    const currTime = new Date(currentEntry.startsAt);
                    const timeDiff = (currTime - prevTime) / (1000 * 60 * 60);

                    if (timeDiff !== 1) {
                        validBlock = false;
                        break;
                    }
                }
            }

            if (validBlock) {
                const avgPrice = totalPrice / requiredHours;
                if (avgPrice < lowestAvgPrice) {
                    lowestAvgPrice = avgPrice;
                    bestBlock = {
                        startIndex: i,
                        startTime: new Date(prices[i].startsAt),
                        endTime: new Date(prices[i + requiredHours - 1].startsAt),
                        avgPrice: avgPrice,
                        prices: prices.slice(i, i + requiredHours)
                    };
                }
            }
        }

        if (!bestBlock) {
            throw new Error("No valid consecutive cheap hours found");
        }

        return bestBlock;
    }

    /**
     * Set timer with cleanup
     */
    setApplianceTimer(key, callback, delay) {
        // Clear existing timer
        if (this.timers.has(key)) {
            clearTimeout(this.timers.get(key));
        }

        // Set new timer
        const timer = setTimeout(() => {
            this.timers.delete(key);
            callback();
        }, delay);

        this.timers.set(key, timer);
        return timer;
    }

    /**
     * Clear timer
     */
    clearApplianceTimer(key) {
        if (this.timers.has(key)) {
            clearTimeout(this.timers.get(key));
            this.timers.delete(key);
            return true;
        }
        return false;
    }
}

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
    }

    handlesState(stateId) {
        return this.subscriptions.includes(stateId) ||
               stateId.startsWith(`${this.adapter.namespace}.devices.${this.id}.`);
    }

    async onStateChange(id, state) {
        // Handle state changes - override in derived classes
        this.adapter.log.debug(`Device ${this.name}: State ${id} changed to ${state.val}`);
    }

    async startMonitoring() {
        // Start device-specific monitoring - override in derived classes
        this.adapter.log.info(`Started monitoring device: ${this.name}`);
    }

    stop() {
        // Cleanup - override in derived classes
        this.adapter.log.info(`Stopped device: ${this.name}`);
    }

    async sendNotification(message) {
        const prefixedMessage = `${this.name}: ${message}`;
        await this.adapter.sendNotification(prefixedMessage);
    }
}

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
        if (id === this.config.powerStateId) {
            await this.handlePowerChange(parseFloat(state.val) || 0);
        } else if (id.endsWith(".startTime") && state.val && !state.ack) {
            await this.handleManualStartTimeChange(state.val);
        } else if (id.endsWith(".scheduled") && state.val === false && !state.ack) {
            await this.cancelScheduledStart();
        }
    }

    async handlePowerChange(power) {
        const now = Date.now();
        const isRunning = await this.getStateValue("running");
        const isScheduled = await this.getStateValue("scheduled");

        // Update last activity timestamp
        if (power > this.EPS) {
            this.lastAboveZeroTs = now;
            this.clearEndTimers();
        }

        if (!isRunning) {
            await this.handleStartDetection(power, now, isScheduled);
        } else {
            await this.handleEndDetection(power, now);
        }
    }

    async handleStartDetection(power, now, isScheduled) {
        // Check cooldown period
        if (now - this.lastFinishTs < this.COOLDOWN_AFTER_MS) {
            return;
        }

        if (power > this.EPS) {
            if (!this.detectionTimer && !isScheduled) {
                // Manual start detection
                this.adapter.log.debug(`${this.name}: Possible manual start detected`);

                this.detectionTimer = this.adapter.setApplianceTimer(
                    `${this.id}_detection`,
                    async () => {
                        this.detectionTimer = null;

                        const currentPower = await this.getCurrentPower();
                        const currentRunning = await this.getStateValue("running");
                        const currentScheduled = await this.getStateValue("scheduled");

                        if (currentPower > this.EPS && !currentRunning && !currentScheduled) {
                            await this.handleManualStart();
                        }
                    },
                    this.DETECT_TIME_MS
                );
            } else if (!this.startTimer) {
                // Normal start detection
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
        await this.adapter.setStateAsync(`devices.${this.id}.startTime`, new Date().toISOString(), true);

        this.lastAboveZeroTs = Date.now();
        this.clearDryReminder();
        await this.cancelScheduledStart();

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
            await this.adapter.setStateAsync(`devices.${this.id}.startTime`, optimalBlock.startTime.toISOString(), true);
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

        // Switch on
        if (this.config.switchStateId) {
            await this.adapter.setForeignStateAsync(this.config.switchStateId, true);
        }

        // Reset scheduling
        await this.adapter.setStateAsync(`devices.${this.id}.scheduled`, false, true);
        await this.adapter.setStateAsync(`devices.${this.id}.startTime`, "", true);

        await this.sendNotification("Automatically started (Tibber optimized)");
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

// Placeholder classes for other device types
class WashingMachineDevice extends BaseDevice {
    // Similar implementation to DishwasherDevice
    // Can be extended later
}

class DryerDevice extends BaseDevice {
    // Similar implementation to DishwasherDevice
    // Can be extended later
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options) => new SmartAppliances(options);
} else {
    // otherwise start the instance directly
    new SmartAppliances();
}
