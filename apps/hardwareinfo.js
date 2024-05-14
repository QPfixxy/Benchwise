const os = require('os');
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
    const cpuInfo = cpus[0];
    const systemData = await si.system();
    const memoryData = await si.mem();
    const chassisData = await si.chassis();
    const diskData = await si.diskLayout();
    const mediaDevicesInfo = await getMediaDevicesInfo();
    const graphicsInfo = await si.graphics();

    // Determine if graphics card is integrated or dedicated
    let graphicsType = 'N/A';
    let graphicsModel = 'N/A';
    let vram = 'N/A';

    if (graphicsInfo.controllers && graphicsInfo.controllers.length > 0) {
        if (graphicsInfo.controllers[0].vendor.includes('Intel')) {
            graphicsType = 'Integrated';
            graphicsModel = getIntelIntegratedGraphicsModel(graphicsInfo.controllers[0].model);
        } else if (graphicsInfo.controllers[0].vendor.includes('AMD')) {
            graphicsType = 'Integrated';
            graphicsModel = getAMDIntegratedGraphicsModel(graphicsInfo.controllers[0].model);
        } else {
            graphicsType = 'Dedicated';
            graphicsModel = graphicsInfo.controllers[0].model;
            vram = graphicsInfo.controllers[0].vram || 'N/A';
        }
    }

    // Get battery data
    let batteryData = {
        hasBattery: false,
        percent: 'N/A',
        health: 'N/A',
        voltage: 'N/A',
    };

    try {
        batteryData = await si.battery();
    } catch (error) {
        console.error('Error fetching battery information:', error.message);
    }

    return {
        hostname: os.hostname(),
        platform: os.platform(),
        architecture: os.arch(),
        cpuModel: cpuInfo.model,
        cpuSpeed: cpuInfo.speed,
        cpuCores: cpus.length,
        totalMemory: memoryData.total,
        manufacturer: systemData.manufacturer,
        model: systemData.model,
        systemSerialNumber: chassisData.serial || 'N/A',
        ramType: memoryData.ecc ? 'ECC' : 'Non-ECC',
        batteryChargeState: batteryData.hasBattery ? batteryData.percent + '%' : 'N/A',
        batteryHealth: batteryData.hasBattery ? (batteryData.health || 'N/A') : 'N/A',
        batteryChargingVoltage: batteryData.hasBattery ? batteryData.voltage : 'N/A',
        webcam: mediaDevicesInfo.webcam,
        speaker: mediaDevicesInfo.speaker,
        microphone: mediaDevicesInfo.microphone,
        graphicsType: graphicsType,
        graphicsModel: graphicsInfo.controllers && graphicsInfo.controllers.length > 0 ? graphicsInfo.controllers[0].model : 'N/A',
        vram: vram,
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

module.exports = {
    gatherHardwareInfo
};
