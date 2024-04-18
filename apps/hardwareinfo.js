const os = require('os');
const si = require('systeminformation');

async function getSystemInfo() {
  const systemInfo = {};
  
  try {
    const cpus = os.cpus();
    const cpuInfo = cpus[0]; // Assuming all CPUs have similar specs

    const [systemData, memoryData, batteryData, chassisData, diskData, memoryLayout, cpuData] =
      await Promise.all([
        si.system(),
        si.mem(),
        si.battery(),
        si.chassis(),
        si.diskLayout(),
        si.memLayout(),
        si.cpu(),
      ]);

    const ramType = memoryData.type || 'Unknown';

    // Calculate physically installed RAM
    let physicalMemory = 0;
    memoryLayout.forEach(module => {
      physicalMemory += module.size;
    });
    physicalMemory = (physicalMemory / Math.pow(1024, 3)).toFixed(2) + ' GB';

    const hardDrives = diskData.map(disk => `${disk.name || 'N/A'}, Capacity: ${(disk.size / Math.pow(1024, 3)).toFixed(2)} GB, Serial Number: ${disk.serialNum || 'N/A'}`);

    const hardwareInfo = {
      hostname: os.hostname(),
      platform: os.platform(),
      architecture: os.arch(),
      cpuModel: cpuInfo.model,
      cpuSpeed: cpuInfo.speed,
      cpuCores: cpuData.physicalCores,
      physicalMemory: physicalMemory,
      manufacturer: systemData.manufacturer,
      model: systemData.model,
      systemSerialNumber: chassisData.serial || 'N/A',
      ramType: ramType,
      batteryChargeState: batteryData.hasBattery ? batteryData.percent + '%' : 'N/A',
      batteryHealth: batteryData.hasBattery ? (batteryData.health || 'N/A') : 'N/A',
      batteryChargingVoltage: batteryData.hasBattery ? batteryData.voltage : 'N/A',
      hardDrives: hardDrives,
    };

    return hardwareInfo;
  } catch (error) {
    console.error('Error fetching system information:', error);
    throw error; // Rethrow the error to be caught by the caller
  }
}

module.exports = getSystemInfo;