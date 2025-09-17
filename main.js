"use strict";

const utils = require("@iobroker/adapter-core");
const https = require("https");
const DishwasherDevice = require("./lib/DishwasherDevice");
const WashingMachineDevice = require("./lib/WashingMachineDevice");
const DryerDevice = require("./lib/DryerDevice");

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

        // Debug: Log the entire config structure
        this.log.debug(`Full config: ${JSON.stringify(this.config, null, 2)}`);
        this.log.debug(`Notifications config: ${JSON.stringify(this.config.notifications, null, 2)}`);

        // Telegram notification
        if (this.config.notifications?.telegram?.enabled) {
            const instance = this.config.notifications.telegram.instance;
            try {
                // Use sendTo for Telegram adapter
                await this.sendToAsync(instance, "send", { text: message });
                this.log.debug(`Telegram notification sent to ${instance} with message: ${message}`);
            } catch (error) {
                this.log.warn(`Failed to send Telegram notification: ${error.message}`);
            }
        } else {
            this.log.debug("Telegram notifications are disabled in configuration");
        }
    }

    /**
     * Create a ToDoist task if configured
     */
    async createTodoistTask({ content, projectId, dueString, priority }) {
        try {
            const todoistCfg = this.config?.notifications?.todoist;
            if (!todoistCfg || !todoistCfg.enabled) {
                this.log.debug("ToDoist disabled – skipping task creation");
                return null;
            }

            const apiToken = todoistCfg.apiToken?.trim();
            const projId = (projectId || todoistCfg.projectId)?.toString().trim();
            const due = (dueString || todoistCfg.dueString || "today").toString();
            const prio = Number.isFinite(priority) ? priority : (todoistCfg.priority || 2);

            if (!apiToken) {
                this.log.warn("ToDoist API token missing – task not created");
                return null;
            }
            if (!projId) {
                this.log.warn("ToDoist project ID missing – task not created");
                return null;
            }
            if (!content || !content.toString().trim()) {
                this.log.debug("Empty ToDoist content – skipped");
                return null;
            }

            const payload = JSON.stringify({
                content: content.toString(),
                project_id: projId,
                due_string: due,
                priority: prio
            });

            const options = {
                hostname: "api.todoist.com",
                path: "/rest/v2/tasks",
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiToken}`,
                    "Content-Length": Buffer.byteLength(payload)
                },
                timeout: 10000
            };

            this.log.debug(`ToDoist Request: ${JSON.stringify({ projectId: projId, due: due, priority: prio, content }, null, 2)}`);

            const result = await new Promise((resolve, reject) => {
                const req = https.request(options, (res) => {
                    let data = "";
                    res.on("data", chunk => data += chunk);
                    res.on("end", () => {
                        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                            try {
                                const parsed = data ? JSON.parse(data) : {};
                                resolve(parsed);
                            } catch (e) {
                                resolve({ statusCode: res.statusCode, raw: data });
                            }
                        } else {
                            reject(new Error(`ToDoist HTTP ${res.statusCode}: ${data}`));
                        }
                    });
                });
                req.on("error", reject);
                req.on("timeout", () => req.destroy(new Error("ToDoist request timeout")));
                req.write(payload);
                req.end();
            });

            this.log.info(`ToDoist task created: ${result?.id || "ok"}`);
            return result;
        } catch (err) {
            this.log.warn(`ToDoist task creation failed: ${err.message}`);
            return null;
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

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options) => new SmartAppliances(options);
} else {
    // otherwise start the instance directly
    new SmartAppliances();
}
