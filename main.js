"use strict";

const utils = require("@iobroker/adapter-core");
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

        // Migrate existing old device states (devices.<id>.*) to new path devices.<type>s.<id>.*
        await this.migrateOldDeviceObjects();

        // Start device monitoring
        await this.startDeviceMonitoring();

        // Set connection status
        this.setState("info.connection", true, true);
        this.log.info("Smart Appliances Adapter started successfully");

        this.on("message", async obj => {
            this.log.debug(`Received message: ${JSON.stringify(obj)}`);
            if (!obj || !obj.command) return;
            try {
                switch (obj.command) {
                    case "setWashingProgram":
                        await this.handleSetWashingProgram(obj.message || {});
                        if (obj.callback) this.sendTo(obj.from, obj.command, { success: true }, obj.callback);
                        break;
                    case "setStart":
                        const result = await this.handleSetStart(obj.message || {});
                        if (obj.callback) this.sendTo(obj.from, obj.command, result, obj.callback);
                        break;
                    default:
                        this.log.warn(`Unknown message command: ${obj.command}`);
                        if (obj.callback) this.sendTo(obj.from, obj.command, { success: false, error: "Unknown command" }, obj.callback);
                }
            } catch (e) {
                this.log.warn(`Command ${obj.command} failed: ${e.message}`);
                if (obj?.callback) this.sendTo(obj.from, obj.command, { success: false, error: e.message }, obj.callback);
            }
        });
    }

    /**
     * Load devices from adapter configuration
     */
    async loadDevices() {
        const collected = [];

        const scan = (obj, path = '') => {
            if (!obj || typeof obj !== 'object') return;
            for (const k of Object.keys(obj)) {
                const v = obj[k];
                const curPath = path ? `${path}.${k}` : k;
                if (Array.isArray(v)) {
                    // array might be a list of devices
                    if (v.length > 0 && v.some(el => el && (el.id || el.name))) {
                        for (const el of v) collected.push({ entry: el, sourceKey: curPath });
                    }
                } else if (v && typeof v === 'object') {
                    scan(v, curPath);
                }
            }
        };

        scan(this.config || {});

        // Deduplicate by id
        const unique = new Map();
        for (const item of collected) {
            const d = item.entry;
            if (!d) continue;
            // If it's a config description (from admin json), it may have 'attr' instead of real config
            if (!d.id && d.attr) continue;
            if (!d.id) continue;
            if (!unique.has(d.id)) unique.set(d.id, { config: d, sourceKey: item.sourceKey });
        }

        for (const [id, info] of unique.entries()) {
            const deviceConfig = Object.assign({}, info.config);
            const sourceKey = info.sourceKey || '';

            if (deviceConfig.enabled === false) {
                this.log.debug(`Skipping disabled device: ${id}`);
                continue;
            }

            // Infer type from sourceKey if missing
            if (!deviceConfig.type) {
                const sk = sourceKey.toLowerCase();
                if (sk.includes('wash')) deviceConfig.type = 'washingmachine';
                else if (sk.includes('dish')) deviceConfig.type = 'dishwasher';
                else if (sk.includes('dryer')) deviceConfig.type = 'dryer';
            }

            // Map pressStateId -> startTriggerStateId
            if (!deviceConfig.startTriggerStateId && deviceConfig.pressStateId) {
                deviceConfig.startTriggerStateId = deviceConfig.pressStateId;
            }

            if (!deviceConfig.type) {
                this.log.warn(`Device '${id}' has no inferred type (sourceKey='${sourceKey}') - skipping`);
                continue;
            }

            this.log.info(`Loading device: ${deviceConfig.name || id} (${deviceConfig.type})`);

            let device;
            switch (deviceConfig.type) {
                case 'dishwasher': device = new DishwasherDevice(this, deviceConfig); break;
                case 'washingmachine': device = new WashingMachineDevice(this, deviceConfig); break;
                case 'dryer': device = new DryerDevice(this, deviceConfig); break;
                default:
                    this.log.warn(`Unknown device type: ${deviceConfig.type} for device ${id}`);
                    continue;
            }

            await device.init();
            this.devices.set(id, device);
        }

        this.log.info(`Loaded ${this.devices.size} devices`);
    }

    /**
     * Start monitoring all devices
     */
    async startDeviceMonitoring() {
        for (const device of this.devices.values()) {
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
            for (const timer of this.timers.values()) {
                clearTimeout(timer);
            }
            this.timers.clear();

            // Stop all devices
            for (const device of this.devices.values()) {
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
            this.log.debug(`State ${id} change triggered: ${state.val} (ack = ${state.ack})`);
            // Immer weiterleiten an Devices (auch manuelle Änderungen), Devices unterscheiden über ack
            for (const device of this.devices.values()) {
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
    async sendNotification(message) {
        this.log.info(`Notification: ${message}`);

        // Telegram notifications
        if (this.config.telegramEnabled && this.config.telegramInstance) {
            try {
                await this.sendToAsync(this.config.telegramInstance, "send", { text: message });
                this.log.debug(`Telegram notification sent to ${this.config.telegramInstance} with message: ${message}`);
            } catch (error) {
                this.log.warn(`Failed to send Telegram notification: ${error.message}`);
            }
        } else {
            this.log.debug("Telegram notifications are disabled or not fully configured");
        }
    }

    /**
     * Send a request to the ToDoist adapter
     */
    async sendTodoistRequest(taskData, logPrefix = "ToDoist") {
        if (!this.config.todoistEnabled) {
            this.log.debug(`${logPrefix} disabled – skipping request`);
            return null;
        }
        const todoistInstance = (this.config.todoistInstance || "todoist2.0").toString();
        this.log.debug(`${logPrefix} request to ${todoistInstance}: ${JSON.stringify(taskData)}`);
        try {
            const result = await this.sendToAsync(todoistInstance, "send", taskData);
            this.log.debug(`${logPrefix} response: ${JSON.stringify(result)}`);
            return result;
        } catch (err) {
            this.log.warn(`${logPrefix} request failed: ${err.message}`);
            return null;
        }
    }

    /**
     * Create a ToDoist task using todoist2.0 adapter
     */
    async createTodoistTask({ content, projectId, sectionId, priority, parentId, order }) {
        const projId = projectId || this.config.todoistProjectId;
        const sectId = sectionId || this.config.todoistSectionId;
        const prio = Number.isFinite(priority) ? Number(priority) : Number(this.config.todoistPriority || 2);

        if (!projId) {
            this.log.warn("ToDoist project ID missing – task not created");
            return null;
        }
        if (!content || !content.toString().trim()) {
            this.log.debug("Empty ToDoist content – skipped");
            return null;
        }

        const taskData = {
            funktion: "add_task",
            task: content.toString(),
            project_id: Number(projId),
            priority: prio,
            date: "today",
        };
        if (sectId) taskData.section_id = Number(sectId);
        if (parentId) {
            taskData.parent_id = Number(parentId);
            delete taskData.date;
        }
        if (order) taskData.order = order;

        const result = await this.sendTodoistRequest(taskData, "ToDoist create");
        this.log.info(`ToDoist task created via adapter: ${result?.id || "ok"}`);
        return result;
    }

    /**
     * Close a ToDoist task using todoist2.0 adapter
     */
    async closeTodoistTask(taskId) {
        if (!taskId) {
            this.log.warn("No ToDoist task ID provided – cannot close task");
            return null;
        }

        const taskData = {
            funktion: "close_task",
            task_id: Number(taskId)
        };

        const result = await this.sendTodoistRequest(taskData, "ToDoist close");
        this.log.info(`ToDoist task closed via adapter: ${taskId}`);
        return result;
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

    /**
     * Handle setWashingProgram via sendTo
     */
    async handleSetWashingProgram(params) {
        const { program, withDryer } = params;
        // Validate config
        if (!Array.isArray(this.config.washingPrograms) || this.config.washingPrograms.length === 0) {
            this.log.warn("No washing programs configured. Please check adapter settings.");
            return;
        }
        if (!program) {
            this.log.warn("No washing program provided");
            return;
        }
        // Find program config
        const progConfig = this.config.washingPrograms.find(p => p.program === program);
        if (!progConfig) {
            this.log.warn(`Washing program '${program}' not found in config`);
            return;
        }
        if (!progConfig.duration || typeof progConfig.duration !== "number" || progConfig.duration <= 0) {
            this.log.warn(`Invalid duration for washing program '${program}' in config.`);
            return;
        }
        // Use default withDryer if not provided
        const dryerNeeded = typeof withDryer === "boolean" ? withDryer : !!progConfig.withDryer;
        const dryerDuration = Number(this.config.dryerDuration) || 180;
        if (dryerNeeded && (!dryerDuration || dryerDuration <= 0)) {
            this.log.warn("Invalid dryer duration in config.");
            return;
        }
        // Delegate to WashingMachineDevice for planning
        for (const device of this.devices.values()) {
            if (device instanceof WashingMachineDevice) {
                await device.planWashingProgram({ program, duration: progConfig.duration, dryerNeeded, dryerDuration });
            }
        }
    }

    /**
     * Handle setStart via sendTo
     */
    async handleSetStart(params) {
        const { device, start, schedule = true } = params;
        if (!device) {
            return { success: false, error: "Parameter 'device' fehlt" };
        }
        if (!start) {
            return { success: false, error: "Parameter 'start' fehlt" };
        }

        // Gerät anhand von Name (case-insensitive) oder ID finden
        let target = null;
        for (const dev of this.devices.values()) {
            if (dev.id === device || dev.name === device || dev.name.toLowerCase() === String(device).toLowerCase()) {
                target = dev; break;
            }
        }
        if (!target) {
            return { success: false, error: `Gerät '${device}' nicht gefunden` };
        }
        if (!target.genericScheduling) {
            return { success: false, error: `Gerät '${device}' unterstützt kein Scheduling` };
        }

        // Datum parsen (deutsches Format dd.mm.yyyy HH:MM oder ISO fallback)
        let date = null;
        if (typeof start === "string") {
            const trimmed = start.trim();
            // Nur Zeit? (HH:MM)
            const reTimeOnly = /^(\d{1,2}):(\d{2})$/;
            const mt = trimmed.match(reTimeOnly);
            if (mt) {
                let h = parseInt(mt[1], 10);
                let mi = parseInt(mt[2], 10);
                if (h >= 0 && h < 24 && mi >= 0 && mi < 60) {
                    const now = new Date();
                    date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi, 0, 0);
                    // Wenn Zeitpunkt heute schon vorbei ist -> morgen
                    if (date.getTime() <= now.getTime()) {
                        date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, h, mi, 0, 0);
                    }
                }
            }
            if (!date) {
                const re = /^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/;
                const m = trimmed.match(re);
                if (m) {
                    const [ , dStr, moStr, yStr, hStr, minStr ] = m;
                    const d = parseInt(dStr, 10);
                    const mo = parseInt(moStr, 10) - 1;
                    const y = parseInt(yStr, 10);
                    const h = parseInt(hStr, 10);
                    const mi = parseInt(minStr, 10);
                    date = new Date(y, mo, d, h, mi, 0, 0);
                } else {
                    // ISO oder anderes Format versuchen
                    const tmp = new Date(trimmed);
                    if (!isNaN(tmp.getTime())) date = tmp;
                }
            }
        } else if (start instanceof Date) {
            date = start;
        }

        if (!date || isNaN(date.getTime())) {
            return { success: false, error: `Ungültiges Datumsformat: '${start}' (erwartet dd.mm.yyyy HH:MM)` };
        }

        // Start durchführen
        if (schedule) {
            await target.scheduleStartAt(date);
        } else {
            await target.setStateAsync(`startTime`, date.toISOString(), true);
            await target.setStateAsync(`scheduled`, false, true);
        }

        this.log.info(`Startzeit für Gerät '${target.name}' gesetzt: ${date.toLocaleString('de-DE')} (schedule=${schedule})`);
        return { success: true, device: target.name, startTime: date.toISOString(), scheduled: schedule };
    }

    // Migrate old device states to new devices.<type>s.<id> structure
    async migrateOldDeviceObjects() {
        this.log.info('Checking for legacy device objects to migrate...');
        const keysToCopy = ["running","scheduled","startTime","runtime","task_id","subtask_gewaschen_id","transferBufferMinutes","avgPrice","startDetected"];
        for (const [id, device] of this.devices) {
            try {
                // old prefix
                const oldPrefix = `devices.${id}`;
                // check if old channel exists
                const oldObj = await this.getObjectAsync(`${oldPrefix}`);
                if (!oldObj) continue;

                // copy states if new state is empty or missing
                for (const key of keysToCopy) {
                    try {
                        const oldState = await this.getStateAsync(`${oldPrefix}.${key}`);
                        const newState = await device.getStateAsync ? await device.getStateAsync(key) : await this.getStateAsync(`${device.channelId()}.${key}`);
                        if (oldState && oldState.val !== undefined && (newState === null || newState === undefined || newState.val === "")) {
                            await device.setStateAsync(key, oldState.val, true);
                            this.log.info(`Migrated ${oldPrefix}.${key} -> ${device.channelId()}.${key}`);
                        }
                    } catch (e) {
                        this.log.debug(`Migration: failed copying ${oldPrefix}.${key}: ${e.message}`);
                    }
                }
            } catch (e) {
                this.log.debug(`Migration: error for device ${id}: ${e.message}`);
            }
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options) => new SmartAppliances(options);
} else {
    // otherwise start the instance directly
    new SmartAppliances();
}
