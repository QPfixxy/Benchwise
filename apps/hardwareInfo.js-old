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
    const batteryData = await si.battery();
    const chassisData = await si.chassis();
    const diskData = await si.diskLayout();
    const mediaDevicesInfo = await getMediaDevicesInfo();

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
        hardDrives: diskData.map(disk => ({
            totalCapacity: (disk.size / Math.pow(1024, 3)).toFixed(2) + ' GB',
            serialNumber: disk.serialNum || 'N/A',
            modelName: disk.name || 'N/A',
        })),
    };
}

module.exports = {
    gatherHardwareInfo
};
