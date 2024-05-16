const os = require('os');
const fs = require('fs');
const si = require('systeminformation');

async function getMediaDevicesInfo() {
    try {
        const webcamInfo = await si.graphics();
        const speakerInfo = await si.audio();
        const microphoneInfo = await si.audio();

        const webcamModel = webcamInfo.controllers && webcamInfo.controllers.length > 0 ? webcamInfo.controllers[0].model : 'N/A';
        const speakerModel = speakerInfo && speakerInfo.length > 0 ? speakerInfo[0].name : 'N/A';
        const microphoneModel = microphoneInfo && microphoneInfo.length > 1 ? microphoneInfo[1].name : 'N/A';

        return {
            webcam: webcamModel,
            speaker: speakerModel,
            microphone: microphoneModel,
        };
    } catch (error) {
        console.error('Error fetching media devices information:', error.message);
        return {
            webcam: 'N/A',
            speaker: 'N/A',
            microphone: 'N/A',
        };
    }
}

async function gatherHardwareInfo() {
    const cpus = os.cpus();
    const cpuInfo = os.cpus()[0];
    const cpuData = await si.cpu();
    const systemData = await si.system();
    const memoryData = await si.mem();
    const diskData = await si.diskLayout();
    const mediaDevicesInfo = await getMediaDevicesInfo();
    const graphicsInfo = await si.graphics();
    const baseboardData = await si.baseboard();

    // Determine if graphics card is integrated or dedicated
    let integratedGraphics = null;
    let dedicatedGraphics = null;
    let vram = 'N/A';

    if (graphicsInfo.controllers && graphicsInfo.controllers.length > 0) {
        graphicsInfo.controllers.forEach(controller => {
            if (controller.vendor.includes('Intel')) {
                integratedGraphics = {
                    type: 'Integrated',
                    model: getIntelIntegratedGraphicsModel(controller.model)
                };
            } else if (controller.vendor.includes('AMD')) {
                integratedGraphics = {
                    type: 'Integrated',
                    model: getAMDIntegratedGraphicsModel(controller.model)
                };
            } else {
                dedicatedGraphics = {
                    type: 'Dedicated',
                    model: controller.model,
                    vram: formatVRAM(controller.vram)
                };
            }
        });
    }

    // Get battery data
    let batteryData = {
        hasBattery: false,
        percent: 'N/A',
        health: 'N/A',
        voltage: 'N/A',
    };
    
    try {
        const batteryInfo = await si.battery();
        batteryData.hasBattery = batteryInfo.hasBattery;
        batteryData.percent = batteryInfo.percent;
        batteryData.voltage = batteryInfo.voltage;
    
        if (batteryInfo.currentCapacity && batteryInfo.designedCapacity) {
            const healthPercentage = (batteryInfo.currentCapacity / batteryInfo.designedCapacity) * 100;
            batteryData.health = `${healthPercentage.toFixed(2)}%`;
        }
    } catch (error) {
        console.error('Error fetching battery information:', error.message);
    }

    return {
        hostname: os.hostname(),
        platform: os.platform(),
        architecture: os.arch(),
        cpuModel: cpuInfo.model,
        cpuSpeed: (cpuInfo.speed / 1000).toFixed(2) + ' GHz',
        cpuCores: cpuData.physicalCores,
        totalMemory: Math.round(memoryData.total / Math.pow(1024, 3)) + ' GB',
        manufacturer: systemData.manufacturer,
        model: systemData.model,
        systemSerialNumber: systemData.serial || 'N/A',
        motherboardSerialNumber: baseboardData.serial || 'N/A', // Added motherboard serial number
        ramProfile: memoryData.ecc ? 'ECC' : 'Non-ECC',
        ramType: memoryData.type || 'N/A',
        batteryChargeState: batteryData.hasBattery ? batteryData.percent + '%' : 'N/A',
        batteryHealth: batteryData.hasBattery ? (batteryData.health || 'N/A') : 'N/A',
        batteryChargingVoltage: batteryData.hasBattery ? batteryData.voltage : 'N/A',
        webcam: mediaDevicesInfo.webcam,
        speaker: mediaDevicesInfo.speaker,
        microphone: mediaDevicesInfo.microphone,
        integratedGraphicsType: integratedGraphics ? integratedGraphics.type : 'N/A',
        integratedGraphicsModel: integratedGraphics ? integratedGraphics.model : 'N/A',
        dedicatedGraphicsType: dedicatedGraphics ? dedicatedGraphics.type : 'N/A',
        dedicatedGraphicsModel: dedicatedGraphics ? dedicatedGraphics.model : 'N/A',
        vram: dedicatedGraphics ? dedicatedGraphics.vram : 'N/A',
        hardDrives: diskData.map(disk => ({
            totalCapacity: (disk.size / Math.pow(1024, 3)).toFixed(2) + ' GB',
            serialNumber: disk.serialNum || 'N/A',
            modelName: disk.name || 'N/A',
        })),
    };
}

function getIntelIntegratedGraphicsModel(model) {
    const intelGraphicsMap = {
        'Iris Xe Graphics': 'Intel Iris Xe Graphics',
        'Iris Plus Graphics': 'Intel Iris Plus Graphics',
        'Iris Graphics': 'Intel Iris Graphics',
        'UHD Graphics': 'Intel UHD Graphics',
        'HD Graphics': 'Intel HD Graphics',
        'Graphics': 'Intel Graphics',
    };
    
    for (const [key, value] of Object.entries(intelGraphicsMap)) {
        if (model.includes(key)) {
            return value + ' ' + model.replace(key, '').trim();
        }
    }
    
    return 'Intel Integrated Graphics';
}

function getAMDIntegratedGraphicsModel(model) {
    const amdGraphicsMap = {
        'Vega': 'AMD Radeon Vega Graphics',
        'Radeon RX': 'AMD Radeon RX Graphics',
        'Radeon Pro': 'AMD Radeon Pro Graphics',
        'Radeon': 'AMD Radeon Graphics',
    };

    for (const [key, value] of Object.entries(amdGraphicsMap)) {
        if (model.includes(key)) {
            return value + ' ' + model.replace(key, '').trim();
        }
    }
    
    return 'AMD Integrated Graphics';
}

function formatVRAM(vram) {
    if (vram < 1024) {
        return vram + ' MB';
    } else {
        return (vram / 1024).toFixed(2) + ' GB';
    }
}

module.exports = {
    gatherHardwareInfo
};
