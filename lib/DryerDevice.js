"use strict";

const BaseDevice = require("./BaseDevice");

// Dryer Device Implementation
class DryerDevice extends BaseDevice {
    constructor(adapter, config) {
        super(adapter, config);

        // Dryer specific parameters - can be extended later
        this.EPS = config.powerThreshold || 0.5;
        this.DETECT_TIME_MS = (config.detectTimeSeconds || 10) * 1000;
        this.REQUIRED_HOURS = config.requiredHours || 2;
    }

    async createDeviceObjects(deviceId) {
        const dryerStates = [
            {
                id: "program",
                common: {
                    name: "Current drying program",
                    type: "string",
                    role: "value",
                    read: true,
                    write: false,
                    def: ""
                }
            },
            {
                id: "dryLevel",
                common: {
                    name: "Target dry level",
                    type: "string",
                    role: "value",
                    read: true,
                    write: false,
                    def: ""
                }
            }
        ];

        for (const state of dryerStates) {
            await this.adapter.setObjectNotExistsAsync(`${deviceId}.${state.id}`, {
                type: "state",
                common: state.common,
                native: {}
            });
        }
    }

    async onStateChange(id, state) {
        // Basic power monitoring - can be extended similar to DishwasherDevice
        if (id === this.config.powerStateId) {
            const power = parseFloat(state.val) || 0;
            this.adapter.log.debug(`${this.name}: Power changed to ${power}W`);
            // TODO: Implement similar logic to DishwasherDevice
        }
    }
}

module.exports = DryerDevice;
