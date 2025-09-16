"use strict";

const BaseDevice = require("./BaseDevice");

// Washing Machine Device Implementation
class WashingMachineDevice extends BaseDevice {
    constructor(adapter, config) {
        super(adapter, config);

        // Washing machine specific parameters - can be extended later
        this.EPS = config.powerThreshold || 0.5;
        this.DETECT_TIME_MS = (config.detectTimeSeconds || 10) * 1000;
        this.REQUIRED_HOURS = config.requiredHours || 3;
    }

    async createDeviceObjects(deviceId) {
        const washingMachineStates = [
            {
                id: "cycle",
                common: {
                    name: "Current wash cycle",
                    type: "string",
                    role: "value",
                    read: true,
                    write: false,
                    def: ""
                }
            },
            {
                id: "temperature",
                common: {
                    name: "Wash temperature",
                    type: "number",
                    role: "value",
                    unit: "°C",
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
        // Basic power monitoring - can be extended similar to DishwasherDevice
        if (id === this.config.powerStateId) {
            const power = parseFloat(state.val) || 0;
            this.adapter.log.debug(`${this.name}: Power changed to ${power}W`);
            // TODO: Implement similar logic to DishwasherDevice
        }
    }
}

module.exports = WashingMachineDevice;
