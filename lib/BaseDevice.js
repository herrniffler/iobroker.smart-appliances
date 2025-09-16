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
        // Override in derived classes to restore device-specific timers
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

module.exports = BaseDevice;
