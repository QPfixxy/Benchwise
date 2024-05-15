// IOfetch.js

const usb = require('usb');

function getIODevices() {
  return new Promise((resolve, reject) => {
    let devices = usb.getDeviceList();
    let ioDevices = devices
      .filter(device => {
        return device.deviceDescriptor.bDeviceClass === 0 || 
               (device.deviceDescriptor.bDeviceClass === 3 && 
                (device.deviceDescriptor.bDeviceSubClass === 0x00 || device.deviceDescriptor.bDeviceSubClass === 0x01)) ||
               (device.deviceDescriptor.bDeviceClass === 8 && device.deviceDescriptor.bDeviceSubClass === 0x06 && device.deviceDescriptor.bDeviceProtocol === 0x20) ||
               (device.deviceDescriptor.bDeviceClass === 0x08 && device.deviceDescriptor.bDeviceSubClass === 0x06 && device.deviceDescriptor.bDeviceProtocol === 0x50) ||
               (device.deviceDescriptor.bDeviceClass === 0x01 && device.deviceDescriptor.bDeviceSubClass === 0x01);
      });
    let mappedIODevices = ioDevices.map(device => {
      let deviceType = 'Unknown';
      if (device.deviceDescriptor.bDeviceClass === 0) {
        let portType = 'Unknown';
        if (device.deviceDescriptor.bcdUSB === 0x300) {
          portType = 'USB 3.0';
        } else if (device.deviceDescriptor.bcdUSB === 0x210) {
          portType = 'USB 2.1';
        } else if (device.deviceDescriptor.bcdUSB === 0x200) {
          portType = 'USB 2.0';
        } else if (device.deviceDescriptor.bcdUSB === 0x110) {
          portType = 'USB 1.1';
        }
        deviceType = `USB (${portType})`;
      } else if (device.deviceDescriptor.bDeviceClass === 3) {
        if(device.deviceDescriptor.bDeviceSubClass === 0x00){
          deviceType = 'Display';
        } else if(device.deviceDescriptor.bDeviceSubClass === 0x01){
          deviceType = 'HDMI';
        }
      } else if (device.deviceDescriptor.bDeviceClass === 8 && device.deviceDescriptor.bDeviceSubClass === 0x06 && device.deviceDescriptor.bDeviceProtocol === 0x20){
        deviceType = 'Ethernet';
      } else if (device.deviceDescriptor.bDeviceClass === 0x08 && device.deviceDescriptor.bDeviceSubClass === 0x06 && device.deviceDescriptor.bDeviceProtocol === 0x50){
        deviceType = 'Micro-SD';
      } else if (device.deviceDescriptor.bDeviceClass === 0x01 && device.deviceDescriptor.bDeviceSubClass === 0x01){
        deviceType = 'Audio';
      }
      return {
        port: `${device.busNumber}-${device.deviceAddress}`,
        manufacturer: device.manufacturer,
        serialNumber: device.serialNumber,
        deviceType: deviceType
      };
    });
    resolve(mappedIODevices);
  });
}

module.exports = { getIODevices };
