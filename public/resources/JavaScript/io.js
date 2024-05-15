async function fetchIODevices() {
    const response = await fetch('/iodevices');
    const ioDevices = await response.json();
    const ioDevicesList = document.getElementById('ioDevices');
    ioDevices.forEach(device => {
      const listItem = document.createElement('li');
      listItem.innerHTML = `<b>Port:</b> ${device.port}, <b>Manufacturer:</b> ${device.manufacturer}, <b>Serial Number:</b> ${device.serialNumber}, <b>Type:</b> ${device.deviceType}`;
      ioDevicesList.appendChild(listItem);
    });
  }

  fetchIODevices();