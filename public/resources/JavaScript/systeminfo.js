      document.addEventListener('DOMContentLoaded', function() {
        getHardwareInfo();
      });
  
      function generateQRCode(text) {
        var qr = qrcode(0, 'M');
        qr.addData(text);
        qr.make();
        return qr.createImgTag();
      }
  
      function getHardwareInfo() {
        fetch('/hardware-info')
          .then(response => response.json())
          .then(data => {
            displayHardwareInfo(data);
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
              <td colspan="3">Model: ${data.dedicatedGraphicsModel},   VRAM: ${data.vram}</td>
          </tr>`
          ;

          document.getElementById('ramInfoSection').innerHTML = `
            <tr>
              <th colspan="5">RAM Information</th>
            </tr>
            <tr>
            <td>Total System Capacity:</td>
            <td colspan="4">${data.totalMemory}</td>
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