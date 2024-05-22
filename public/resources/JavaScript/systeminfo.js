document.addEventListener('DOMContentLoaded', function() {
  showSerialNumberModal();
});

function showSerialNumberModal() {
  const modal = document.getElementById('myModal');
  const serialNumberInput = document.getElementById('serialNumberInput');
  const submitButton = document.getElementById('submitSerialNumber');
  const loadingText = document.getElementById('loadingText');
  const hardwareTable = document.getElementById('hardwareTable');

  modal.style.display = 'block';

  serialNumberInput.focus();

  submitButton.onclick = function() {
    const serialNumber = serialNumberInput.value.trim();
    if (serialNumber && /^\d{7}-\d{7}$/.test(serialNumber)) {
      modal.style.display = 'none'; 
      loadingText.style.display = 'block'; 

      getHardwareInfo(serialNumber);
    } else {
      alert('Invalid serial number format. Please use 0000000-0000000.');
      serialNumberInput.value = ''; 
      serialNumberInput.focus(); 
    }
  };

  serialNumberInput.addEventListener('keypress', function(event) {
    if (event.key === 'Enter') {
      submitButton.click();
    }
  });
}


function generateQRCode(text) {
  var qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createImgTag();
}

function getHardwareInfo(serialNumber) {
  fetch('/hardware-info')
    .then(response => response.json())
    .then(data => {
      displayHardwareInfo(data);
      document.getElementById('loadingText').style.display = 'none'; 
      document.getElementById('hardwareTable').style.display = 'table'; 
      exportPDF(data, serialNumber); 
    })
    .catch(error => {
      console.error('Error fetching hardware information:', error.message);
      displayError();
    });
}

function displayHardwareInfo(data) {
  document.getElementById('systemInfoSection').innerHTML = `
    <tr>
      <th>System Information</th>
      <td>Make: ${data.manufacturer}</td>
      <td>Model: ${data.model}</td>
      <td>Serial Number: ${data.systemSerialNumber}</td>
      <td class="qr-code">${generateQRCode(data.systemSerialNumber)}</td>
    </tr>
  `;

  document.getElementById('cpuInfoSection').innerHTML = `
    <tr>
      <th>CPU Information</th>
      <td colspan="4">Model: ${data.cpuModel}, Speed: ${data.cpuSpeed}, Cores: ${data.cpuCores}</td>
    </tr>
  `;

  document.getElementById('graphicsInfoSection').innerHTML = `
    <tr>
        <th>Integrated Graphics</th>
        <td>Type: ${data.integratedGraphicsType}</td>
        <td colspan="3">Model: ${data.integratedGraphicsModel}</td>
    </tr>
    <tr>
        <th>Dedicated Graphics</th>
        <td>Type: ${data.dedicatedGraphicsType}</td>
        <td colspan="3">Model: ${data.dedicatedGraphicsModel}, VRAM: ${data.vram}</td>
    </tr>`;

  document.getElementById('ramInfoSection').innerHTML = `
    <tr>
      <th colspan="5">RAM Information</th>
    </tr>
    <tr>
      <td>System Total:</td>
      <td colspan="4">${data.ramInfo.totalSize}</td>
    </tr>
    ${data.ramInfo.memorySlots.map((slot, index) => `
      <tr>
        <td>Slot ${index + 1}</td>
        <td>Capacity: ${slot.size}</td>
        <td>Type: ${slot.type}</td>
        <td colspan="2">ECC: ${slot.ecc}</td>
      </tr>
    `).join('')}
  `;

  document.getElementById('batteryInfoSection').innerHTML = `
    <tr>
      <th>Battery Information</th>
      <td colspan="4">Charge State: ${data.batteryChargeState}, Battery Health: ${data.batteryHealth}, Average Charging Voltage: ${data.batteryChargingVoltage} volts</td>
    </tr>
  `;

  document.getElementById('webcamInfoSection').innerHTML = `
    <tr>
      <th>Webcam Information</th>
      <td colspan="4">${data.webcam}</td>
    </tr>
  `;

  document.getElementById('speakerInfoSection').innerHTML = `
    <tr>
      <th>Speaker Information</th>
      <td colspan="4">${data.speaker}</td>
    </tr>
  `;

  document.getElementById('microphoneInfoSection').innerHTML = `
    <tr>
      <th>Microphone Information</th>
      <td colspan="4">${data.microphone}</td>
    </tr>
  `;

  const hardDriveInfoSection = document.getElementById('hardDriveInfoSection');
  hardDriveInfoSection.innerHTML = '';
  data.hardDrives.forEach((drive, index) => {
    hardDriveInfoSection.innerHTML += `
      <tr>
        <th>Hard Drive ${index + 1} Information</th>
        <td>Model: ${drive.modelName}</td>
        <td>Capacity: ${(drive.totalCapacity)} GB</td>
        <td>Serial Number: ${drive.serialNumber}</td>
        <td class="qr-code">${generateQRCode(drive.serialNumber)}</td>
      </tr>
    `;
  });

  const systemSerialNumberElement = document.getElementById('systemSerialNumber');
  if (systemSerialNumberElement.innerHTML === '') {
    const laptopSerialQR = generateQRCode(data.systemSerialNumber);
    systemSerialNumberElement.innerHTML = laptopSerialQR;
  }
}

function displayError() {
  const hardwareTable = document.getElementById('hardwareTable');
  hardwareTable.innerHTML = `
    <tr>
      <td colspan="5">Error fetching hardware information. Please try again later.</td>
    </tr>
  `;
}

function exportPDF(data, serialNumber) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  const tableData = [
    [{content: 'System Information', styles: {fontWeight: 'bold', halign: 'center'}}],
    [`Make: ${data.manufacturer}`],
    [`Model: ${data.model}`],
    [`Serial Number: ${data.systemSerialNumber}`],
    [{content: 'CPU Information', styles: {fontWeight: 'bold', halign: 'center'}}],
    [`Model: ${data.cpuModel}`],
    [`Speed: ${data.cpuSpeed}`],
    [`Cores: ${data.cpuCores}`],
    [{content: 'Integrated Graphics', styles: {fontWeight: 'bold', halign: 'center'}}],
    [`Model: ${data.integratedGraphicsModel}`],
    [{content: 'Dedicated Graphics', styles: {fontWeight: 'bold', halign: 'center'}}],
    [`Model: ${data.dedicatedGraphicsModel}`], 
    [`VRAM: ${data.vram}`],
    [{content: 'RAM Information', styles: {fontWeight: 'bold', halign: 'center'}}],
    [`Total System Memory: ${data.ramInfo.totalSize}`],
    [data.ramInfo.memorySlots.map((slot, index) => `RAM Slot ${index + 1}: Capacity: ${slot.size}, Type: ${slot.type}, ECC: ${slot.ecc}`).join('\n')],
    [{content: 'Battery Information', styles: {fontWeight: 'bold', halign: 'center'}}],
    [`Charge State: ${data.batteryChargeState}`],
    [`Battery Health: ${data.batteryHealth}`],
    [`Average Charging Voltage: ${data.batteryChargingVoltage} volts`],
    [{content: 'Webcam Information', styles: {fontWeight: 'bold', halign: 'center'}}],
    [`${data.webcam}`],
    [{content: 'Speaker Information', styles: {fontWeight: 'bold', halign: 'center'}}],
    [`${data.speaker}`],
    [{content: 'Microphone Information', styles: {fontWeight: 'bold', halign: 'center'}}],
    [`${data.microphone}`],
    [{content: 'Hard Drive Information', styles: {fontWeight: 'bold', halign: 'center'}}],
    [data.hardDrives.map((drive, index) => `Hard Drive ${index + 1}: Model: ${drive.modelName}, Capacity: ${drive.totalCapacity} GB, Serial Number: ${drive.serialNumber}`).join('\n')],
  ];

  doc.autoTable({
    head: [['Audit Report']],
    body: tableData,
  });

  const pdfBlob = doc.output('blob');
  const formData = new FormData();
  formData.append('pdf', pdfBlob); 
  formData.append('serialNumber', serialNumber); 

  fetch('/save-pdf', {
    method: 'POST',
    body: formData
  })
  .then(response => response.json())
  .then(result => {
    console.log('Success:', result);
  })
  .catch(error => {
    console.error('Error:', error);
  });
}
