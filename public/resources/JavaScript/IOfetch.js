async function fetchUSBPorts() {
    try {
        const response = await fetch('/usbPorts');
        if (!response.ok) {
            throw new Error('Failed to fetch USB ports');
        }
        return await response.json();
    } catch (error) {
        console.error('Error fetching USB ports:', error);
        return [];
    }
}

async function fetchUSBDevices() {
    try {
        const response = await fetch('/usbInfo');
        if (!response.ok) {
            throw new Error('Failed to fetch USB devices');
        }
        return await response.json();
    } catch (error) {
        console.error('Error fetching USB devices:', error);
        return [];
    }
}

async function updateUSBStatus() {
    const usbPorts = await fetchUSBPorts();
    const usbList = document.getElementById('usbList');
    usbList.innerHTML = '';

    usbPorts.forEach((port, index) => {
        const listItem = document.createElement('li');
        const usbIcon = document.createElement('div');
        usbIcon.classList.add('usb-icon');
        usbIcon.textContent = `USB Port ${port}`;
        listItem.appendChild(usbIcon);
        usbList.appendChild(listItem);
    });
}

updateUSBStatus();
setInterval(updateUSBStatus, 5000); 