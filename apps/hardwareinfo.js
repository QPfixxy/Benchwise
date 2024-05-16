const os = require('os');
const fs = require('fs');
const si = require('systeminformation');
const util = require('util');

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

async function getSystemSerialNumber() {
    try {
        const systemData = await si.system();
        if (systemData.serial && systemData.serial !== 'To be filled by O.E.M.') {
            return systemData.serial; 
        } else {
            return await fetchSerialNumberByOS();
        }
    } catch (error) {
        console.error('Failed to fetch system serial number via systeminformation:', error);
        return await fetchSerialNumberByOS(); 
    }
}

async function fetchSerialNumberByOS() {
    const platform = os.platform();
    let cmd;

    if (platform === 'win32') {
        cmd = 'wmic bios get serialnumber';
    } else if (platform === 'linux') {
        cmd = 'sudo dmidecode -s system-serial-number';
    } else if (platform === 'darwin') {
        cmd = 'system_profiler SPHardwareDataType | grep "Serial Number (system)"';
    } else {
        return 'N/A'; 
    }

    return new Promise((resolve, reject) => {
        exec(cmd, (error, stdout, stderr) => {
            if (error || stderr) {
                console.error('Command execution error:', error || stderr);
                resolve('N/A');
            } else {
                let output = stdout.split('\n')[platform === 'darwin' ? 1 : 0].trim();
                if (platform === 'darwin') {
                    output = output.split(': ')[1].trim(); 
                }
                resolve(output);
            }
        });
    });
}


async function gatherHardwareInfo() {
    const systemSerialNumber = await getSystemSerialNumber();
    let memoryData;
    try {
        memoryData = await si.memLayout();
    } catch (error) {
        console.error('Failed to fetch memory information via systeminformation:', error);
        console.log('Attempting to fetch memory information using alternative method...');
        memoryData = await fetchMemoryInfoByOS();
    }
    const RamTotal = await si.mem();
    const cpus = os.cpus();
    const cpuInfo = os.cpus()[0];
    const cpuData = await si.cpu();
    const systemData = await si.system();
    const diskData = await si.diskLayout();
    const mediaDevicesInfo = await getMediaDevicesInfo();
    const graphicsInfo = await si.graphics();
    const baseboardData = await si.baseboard();

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

    function getMemoryInfo(memoryData) {
        return memoryData.map(memory => ({
            size: memory.size ? `${(memory.size / Math.pow(1024, 3)).toFixed(2)} GB` : 'N/A',
            speed: memory.speed ? `${memory.speed} MHz` : 'N/A',
            type: memory.type ? memory.type : 'N/A',
            ecc: memory.ecc ? 'ECC' : 'Non-ECC'
        }));
    }

    const totalMemory = RamTotal.total;

    const ramInfo = {
        memorySlots: getMemoryInfo(memoryData),
        totalSize: `${Math.round(totalMemory / Math.pow(1024, 3))} GB`
    };


    return {
        hostname: os.hostname(),
        platform: os.platform(),
        architecture: os.arch(),
        cpuModel: cpuInfo.model,
        cpuSpeed: (cpuInfo.speed / 1000).toFixed(2) + ' GHz',
        cpuCores: cpuData.physicalCores,
        totalMemory: Math.round(RamTotal.total / Math.pow(1024, 3)) + ' GB',
        manufacturer: systemData.manufacturer,
        model: systemData.model,
        systemSerialNumber: systemSerialNumber, 
        ramInfo: ramInfo,
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

async function fetchMemoryInfoByOS() {
    const platform = os.platform();
    let cmd;

    if (platform === 'win32') {
        cmd = 'wmic MEMORYCHIP get Capacity, Speed, MemoryType';
    } else if (platform === 'linux') {
        cmd = 'sudo dmidecode -t 17';
    } else if (platform === 'darwin') {
        cmd = 'system_profiler SPMemoryDataType';
    } else {
        console.error('Unsupported platform:', platform);
        return [];
    }

    try {
        const { stdout, stderr } = await exec(cmd);
        if (stderr) {
            console.error('Command execution error:', stderr);
            return [];
        }

        if (platform === 'win32') {
            return parseMemoryInfoWindows(stdout);
        } else if (platform === 'linux') {
            return parseMemoryInfoLinux(stdout);
        } else if (platform === 'darwin') {
            return parseMemoryInfoMac(stdout);
        }
    } catch (error) {
        console.error('Command execution error:', error);
        return [];
    }
}

function parseMemoryInfoWindows(output) {
    const lines = output.split('\r\r\n');
    const memoryInfo = [];
    lines.forEach(line => {
        const match = line.match(/(\d+)\s+(\d+)\s+(\d+)/);
        if (match) {
            const size = parseInt(match[1]) / (1024 * 1024);
            const speed = parseInt(match[2]);
            const type = parseMemoryTypeWindows(parseInt(match[3]));
            memoryInfo.push({ size, speed, type });
        }
    });
    return memoryInfo;
}



function parseMemoryTypeWindows(type) {
    const memoryTypes = {
        0: 'Unknown',
        1: 'Other',
        2: 'DRAM',
        3: 'Synchronous DRAM',
        4: 'Cache DRAM',
        5: 'EDO',
        6: 'EDRAM',
        7: 'VRAM',
        8: 'SRAM',
        9: 'RAM',
        10: 'ROM',
        11: 'Flash',
        12: 'EEPROM',
        13: 'FEPROM',
        14: 'EPROM',
        15: 'CDRAM',
        16: '3DRAM',
        17: 'SDRAM',
        18: 'SGRAM',
        19: 'RDRAM',
        20: 'DDR',
        21: 'DDR2',
        22: 'DDR2 FB-DIMM',
        24: 'DDR3',
        25: 'FBD2',
         26: 'DDR4',
        27: 'LPDDR',
        28: 'LPDDR2',
        29: 'LPDDR3',
        30: 'LPDDR4',
        31: 'Logical non-volatile device',
        32: 'HBM',
        33: 'HBM2',
        34: 'DDR5',
        35: 'LPDDR5',
    };
    return memoryTypes[type] || 'Unknown';
}

async function parseMemoryInfoLinux(output) {
    const memoryInfo = [];
    let currentMemory = {};
    output.split('\n').forEach(line => {
        if (line.trim().startsWith('Size:')) {
            currentMemory.size = parseInt(line.trim().split(':')[1].trim().split(' ')[0]);
        } else if (line.trim().startsWith('Speed:')) {
            currentMemory.speed = parseInt(line.trim().split(':')[1].trim().split(' ')[0]);
        } else if (line.trim().startsWith('Type:')) {
            currentMemory.type = line.trim().split(':')[1].trim();
        } else if (line.trim() === '') {
            if (Object.keys(currentMemory).length !== 0) {
                memoryInfo.push(currentMemory);
                currentMemory = {};
            }
        }
    });
    return memoryInfo;
}

async function parseMemoryInfoMac(output) {
    const memoryInfo = [];
    let currentMemory = {};
    output.split('\n').forEach(line => {
        if (line.trim().startsWith('Size:')) {
            currentMemory.size = parseInt(line.trim().split(':')[1].trim().split(' ')[0]);
        } else if (line.trim().startsWith('Speed:')) {
            currentMemory.speed = parseInt(line.trim().split(':')[1].trim().split(' ')[0]);
        } else if (line.trim().startsWith('Type:')) {
            currentMemory.type = line.trim().split(':')[1].trim();
        } else if (line.trim() === '') {
            if (Object.keys(currentMemory).length !== 0) {
                memoryInfo.push(currentMemory);
                currentMemory = {};
            }
        }
    });
    return memoryInfo;
}

function getMemoryType(memoryData) {
    const type = memoryData[0]?.type;
    return type ? type : 'N/A';
}

function getMemorySpeed(memoryData) {
    const speed = memoryData[0]?.speed;
    return speed ? `${speed} MHz` : 'N/A';
}

function getMemoryECC(memoryData) {
    const ecc = memoryData[0]?.ecc;
    return ecc ? 'ECC' : 'Non-ECC';
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
